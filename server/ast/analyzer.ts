'use strict';
import * as os from 'os';
import * as path from 'path';

import * as immutable from 'immutable';

import * as ast from '../parser/node';
import * as astVisitor from './visitor';
import * as compiler from './compiler';
import * as error from '../lexer/static_error';
import * as lexer from '../lexer/lexer';
import * as workspace from './workspace';
import * as service from './service';

//
// Analyzer.
//

export interface EventedAnalyzer
  extends workspace.DocumentEventListener, service.UiEventListener { }

// TODO: Rename this to `EventedAnalyzer`.
export class Analyzer implements EventedAnalyzer {
  constructor(
    private documents: workspace.DocumentManager,
    private compilerService: compiler.CompilerService,
  ) { }

  //
  // WorkspaceEventListener implementation.
  //

  public onDocumentOpen = this.compilerService.cache;

  public onDocumentSave = this.compilerService.cache;

  public onDocumentClose = this.compilerService.delete;

  //
  // AnalysisEventListener implementation.
  //

  public onHover = (
    fileUri: string, cursorLoc: error.Location
  ): Promise<service.HoverInfo> => {
    const onHoverPromise = (node: ast.Node): Promise<service.HoverInfo> => {
      return Promise.resolve().then(
        () => <service.HoverInfo> {
          contents: this.renderOnhoverMessage(node),
        });
    }

    // Get symbol we're hovering over.
    const nodeAtPos = this.getNodeAtPosition(fileUri, cursorLoc);
    if (astVisitor.isFindFailure(nodeAtPos)) {
      return Promise.resolve().then(() => {return {contents:[]}});
    }
    if (nodeAtPos.parent != null && ast.isFunctionParam(nodeAtPos.parent)) {
      // A function parameter is a free variable, so we can't resolve
      // it. Simply return.
      return onHoverPromise(nodeAtPos.parent);
    }

    const resolved = this.resolveSymbol(nodeAtPos);
    if (resolved == null) {
      return Promise.resolve().then(
        () => <service.HoverInfo> {
          contents: [],
        });
    }

    // Handle the special cases. If we hover over a symbol that points
    // at a function of some sort (i.e., a `function` literal, a
    // `local` that has a bind that is a function, or an object field
    // that is a function), then we want to render the name and
    // parameters that function takes, rather than the definition of
    // the function itself.
    if (ast.isFunctionParam(resolved) || resolved.parent == null) {
      return onHoverPromise(resolved);
    } else {
      switch (resolved.parent.type) {
        case "FunctionNode":
        case "LocalNode":
        case "ObjectFieldNode": {
          return onHoverPromise(resolved.parent);
        }
        default: {
          return onHoverPromise(resolved);
        }
      }
    }
  }

  public onComplete = (
    fileUri: string, cursorLoc: error.Location
  ): Promise<service.CompletionInfo[]> => {
    const doc = this.documents.get(fileUri);

    return Promise.resolve().then(
      (): service.CompletionInfo[] => {
        //
        // Generate suggestions. This process follows three steps:
        //
        // 1. Try to parse the document text.
        // 2. If we succeed, go to cursor, select that node, and if
        //    it's an identifier that can be completed, then return
        //    the environment.
        // 3. If we fail, go try to go to the "hole" where the
        //    identifier exists.
        //

        try {
          const compiled = this.compilerService.cache(
            fileUri, doc.text, doc.version);
          const lines = doc.text.split("\n");

          // Lets us know whether the user has typed something like
          // `foo` or `foo.` (i.e., whether they are "dotting into"
          // `foo`). In the case of the latter, we will want to emit
          // suggestions from the members of `foo`.
          const lastCharIsDot =
            lines[cursorLoc.line-1][cursorLoc.column-2] === ".";

          let node: ast.Node | null = null;
          if (compiler.isParsedDocument(compiled)) {
            // Success case. The document parses, and we can offer
            // suggestions from a well-formed document.

            return this.completionsFromParse(
              compiled, cursorLoc, lastCharIsDot);
          } else {
            const lastParse = this.compilerService.getLastSuccess(fileUri);
            if (lastParse == null) {
              return [];
            }

            return this.completionsFromFailedParse(
              compiled, lastParse, cursorLoc, lastCharIsDot);
          }
        } catch (err) {
          console.log(err);
          return [];
        }
      });
  }

  //
  // Completion methods.
  //

  // completionsFromParse takes a `ParsedDocument` (i.e., a
  // successfully-parsed document), a cursor location, and an
  // indication of whether the user is "dotting in" to a property, and
  // produces a list of autocomplete suggestions.
  public completionsFromParse = (
    compiled: compiler.ParsedDocument, cursorLoc: error.Location,
    lastCharIsDot: boolean,
  ): service.CompletionInfo[] => {
    // IMPLEMENTATION NOTES: We have kept this method relatively free
    // of calls to `this` so that we don't have to mock out more of
    // the analyzer to test it.

    let foundNode = this.getNodeAtPositionFromAst(
      compiled.parse, cursorLoc);
    if (astVisitor.isAnalyzableFindFailure(foundNode)) {
      if (foundNode.kind === "NotIdentifier") {
        return [];
      }
      if (foundNode.terminalNodeOnCursorLine != null) {
        foundNode = foundNode.terminalNodeOnCursorLine;
      } else {
        foundNode = foundNode.tightestEnclosingNode;
      }
    } else if (astVisitor.isUnanalyzableFindFailure(foundNode)) {
      return [];
    }

    return this.completionsFromNode(foundNode, cursorLoc, lastCharIsDot);
  }

  // completionsFromFailedParse takes a `FailedParsedDocument` (i.e.,
  // a document that does not parse), a `ParsedDocument` (i.e., a
  // last-known good parse for the document), a cursor location, and
  // an indication of whether the user is "dotting in" to a property,
  // and produces a list of autocomplete suggestions.
  public completionsFromFailedParse = (
    compiled: compiler.FailedParsedDocument, lastParse: compiler.ParsedDocument,
    cursorLoc: error.Location, lastCharIsDot: boolean,
  ): service.CompletionInfo[] => {
    // IMPLEMENTATION NOTES: We have kept this method relatively free
    // of calls to `this` so that we don't have to mock out more of
    // the analyzer to test it.
    //
    // Failure case. The document does not parse, so we need
    // to:
    //
    // 1. Obtain a partial parse from the parser.
    // 2. Get our "best guess" for where in the AST the user's
    //    cursor would be, if the document did parse.
    // 3. Use the partial parse and the environment "best
    //    guess" to create suggestions based on the context
    //    of where the user is typing.

    if (
      compiler.isLexFailure(compiled.parse) ||
      compiled.parse.parseError.rest == null
    ) {
      return [];
    }

    // Step 1, get the "rest" of the parse, i.e., the partial
    // parse emitted by the parser.
    const rest = compiled.parse.parseError.rest;
    const restEnd = rest.loc.end;

    if (rest == null) {
      throw new Error(`INTERNAL ERROR: rest should never be null`);
    } else if (
      !cursorLoc.inRange(rest.loc) &&
      !(restEnd.line === cursorLoc.line && cursorLoc.column === restEnd.column + 1)
    ) {
      // Return no suggestions if the parse is not broken at
      // the cursor.
      //
      // NOTE: the `+ 1` correctly captures the case of the
      // user typing `.`.
      return [];
    }

    // Step 2, try to find the "best guess".
    let foundNode = this.getNodeAtPositionFromAst(
      lastParse.parse, cursorLoc);
    if (astVisitor.isAnalyzableFindFailure(foundNode)) {
      if (foundNode.terminalNodeOnCursorLine != null) {
        foundNode = foundNode.terminalNodeOnCursorLine;
      } else {
        foundNode = foundNode.tightestEnclosingNode;
      }
    } else if (astVisitor.isUnanalyzableFindFailure(foundNode)) {
      return [];
    }

    // Step 3, combine the partial parse and the environment
    // of the "best guess" to attempt to create meaningful
    // suggestions for the user.
    if (foundNode.env == null) {
      throw new Error("INTERNAL ERROR: Node environment can't be null");
    }
    new astVisitor
      .InitializingVisitor(rest, foundNode, foundNode.env)
      .visit();

    // Create suggestions.
    return this.completionsFromNode(rest, cursorLoc, lastCharIsDot);
  }

  // completionsFromNode takes a `Node`, a cursor location, and an
  // indication of whether the user is "dotting in" to a property, and
  // produces a list of autocomplete suggestions.
  private completionsFromNode = (
    node: ast.Node, cursorLoc: error.Location, lastCharIsDot: boolean,
  ): service.CompletionInfo[] => {
    // Attempt to resolve the node.
    const resolved = ast.tryResolveIndirections(
      node, this.compilerService, this.documents);

    if (ast.isUnresolved(resolved)) {
      // If we could not even partially resolve a node (as we do,
      // e.g., when an index target resolves, but the ID doesn't),
      // then create suggestions from the environment.
      return node.env != null
        ? envToSuggestions(node.env)
        : [];
    } else if (ast.isUnresolvedIndexTarget(resolved)) {
      // One of the targets in some index expression failed to
      // resolve, so we have no suggestions. For example, in
      // `foo.bar.baz.bat`, if any of `foo`, `bar`, or `baz` fail,
      // then we have nothing to suggest as the user is typing `bat`.
      return [];
    } else if (ast.isUnresolvedIndexId(resolved)) {
      // We have successfully resolved index target, but not the index
      // ID, so generate suggestions from the resolved target. For
      // example, if the user types `foo.b`, then we would generate
      // suggestions from the members of `foo`.
      return this.completionsFromFields(resolved.resolvedTarget);
    } else if (
      ast.isResolvedFunction(resolved) ||
      ast.isResolvedFreeVar(resolved) ||
      (!lastCharIsDot && ast.isIndexedObjectFields(resolved) || ast.isNode(resolved))
    ) {
      // Our most complex case. One of two things is true:
      //
      // 1. Resolved the ID to a function or a free param, in which
      //    case we do not want to emit any suggestions, or
      // 2. The user has NOT typed a dot, AND the resolve node is not
      //    fields addressable, OR it's a node. In other words, the
      //    user has typed something like `foo` (and specifically not
      //    `foo.`, which is covered in another case), and `foo`
      //    completely resolves, either to a value (e.g., a number
      //    like 3) or a set of fields (i.e., `foo` is an object). In
      //    both cases the user has type variable, and we don't want
      //    to suggest anything; if they wanted to see the members of
      //    `foo`, they should type `foo.`.
      return [];
    } else if (lastCharIsDot && ast.isIndexedObjectFields(resolved)) {
      // User has typed a dot, and the resolved symbol is
      // fields-resolvable, so we can return the fields of the
      // expression. For example, if the user types `foo.`, then we
      // can suggest the members of `foo`.
      return this.completionsFromFields(resolved);
    }

    // Catch-all case. Suggest nothing.
    return [];
  }

  //
  // Utilities.
  //

  private renderOnhoverMessage = (node: ast.Node): service.LanguageString[] => {
    const commentText: string | null = this.resolveComments(node);

    const doc = this.documents.get(node.loc.fileName);
    let line: string = doc.text.split(os.EOL)
      .slice(node.loc.begin.line - 1, node.loc.end.line)
      .join("\n");

    if (ast.isFunctionParam(node)) {
      // A function parameter is either a free variable, or a free
      // variable with a default value. Either way, there's not more
      // we can know statically, so emit that.
      line = node.prettyPrint();
    }

    line = node.prettyPrint();

    return <service.LanguageString[]>[
      {language: 'jsonnet', value: line},
      commentText,
    ];
  }

  private completionsFromFields = (
    fieldSet: ast.IndexedObjectFields
  ): service.CompletionInfo[] => {
    // Attempt to get all the possible fields we could suggest. If the
    // resolved item is an `ObjectNode`, just use its fields; if it's
    // a mixin of two objects, merge them and use the merged fields
    // instead.

    return immutable.List(fieldSet.values())
      .filter((field: ast.ObjectField) =>
        field != null && field.id != null && field.expr2 != null && field.kind !== "ObjectLocal")
      .map((field: ast.ObjectField) => {
        if (field == null || field.id == null || field.expr2 == null) {
          throw new Error(
            `INTERNAL ERROR: Filtered out null fields, but found field null`);
        }

        let kind: service.CompletionType = "Field";
        if (field.methodSugar) {
          kind = "Method";
        }

        const comments = this.getComments(field);
        return {
          label: field.id.name,
          kind: kind,
          documentation: comments || undefined,
        };
      })
      .toArray();
  }

  //
  // Symbol resolution.
  //

  public resolveSymbolAtPosition = (
    fileUri: string, pos: error.Location,
  ): ast.Node | null => {
    let nodeAtPos = this.getNodeAtPosition(fileUri, pos);
    if (astVisitor.isAnalyzableFindFailure(nodeAtPos)) {
      nodeAtPos = nodeAtPos.tightestEnclosingNode;
    } else if (astVisitor.isUnanalyzableFindFailure(nodeAtPos)) {
      return null;
    }
    return this.resolveSymbol(nodeAtPos);
  }

  public resolveSymbolAtPositionFromAst = (
    rootNode: ast.Node, pos: error.Location,
  ): ast.Node | null => {
    let nodeAtPos = this.getNodeAtPositionFromAst(rootNode, pos);
    if (astVisitor.isAnalyzableFindFailure(nodeAtPos)) {
      nodeAtPos = nodeAtPos.tightestEnclosingNode;
    } else if (astVisitor.isUnanalyzableFindFailure(nodeAtPos)) {
      return null;
    }
    return this.resolveSymbol(nodeAtPos);
  }

  // resolveComments takes a node as argument, and attempts to find the
  // comments that correspond to that node. For example, if the node
  // passed in exists inside an object field, we will explore the parent
  // nodes until we find the object field, and return the comments
  // associated with that (if any).
  public resolveComments = (node: ast.Node | null): string | null => {
    while (true) {
      if (node == null) { return null; }

      switch (node.type) {
        case "ObjectFieldNode": {
          // Only retrieve comments for.
          const field = <ast.ObjectField>node;
          if (field.kind != "ObjectFieldID" && field.kind == "ObjectFieldStr") {
            return null;
          }

          // Convert to field object, pull comments out.
          return this.getComments(field);
        }
        default: {
          node = node.parent;
          continue;
        }
      }
    }
  }

  private resolveSymbol = (node: ast.Node): ast.Node | null => {
    if (node.parent && ast.isObjectField(node.parent)) {
      return node.parent;
    }

    switch(node.type) {
      case "IdentifierNode": {
        const resolved = (<ast.Identifier>node).resolve(
          this.compilerService, this.documents);
        if (ast.isIndexedObjectFields(resolved) || ast.isResolveFailure(resolved)) {
          return null;
        }
        return resolved;
      }
      case "LocalNode": {
        return node;
      }
      default: {
        return null;
      }
    }
  }

  //
  // Utilities.
  //

  private getComments = (field: ast.ObjectField): string | null => {
    // Convert to field object, pull comments out.
    const comments = field.headingComments;
    if (comments == null || comments.count() == 0) {
      return null;
    }

    return comments
      .reduce((acc: string[], curr) => {
        if (curr == undefined) {
          throw new Error(`INTERNAL ERROR: element was undefined during a reduce call`);
        }
        acc.push(curr.text);
        return acc;
      }, [])
      .join("\n");
  }

  public getNodeAtPosition = (
    fileUri: string, pos: error.Location,
  ): ast.Node | astVisitor.FindFailure => {
    const {text: docText, version: version} = this.documents.get(fileUri);
    const cached = this.compilerService.cache(fileUri, docText, version);
    if (compiler.isFailedParsedDocument(cached)) {
      // TODO: Handle this error without an exception.
      const err = compiler.isLexFailure(cached.parse)
        ? cached.parse.lexError.Error()
        : cached.parse.parseError.Error();
      throw new Error(
        `INTERNAL ERROR: Could not cache analysis of file ${fileUri}:\b${err}`);
    }

    return this.getNodeAtPositionFromAst(cached.parse, pos);
  }

  public getNodeAtPositionFromAst = (
    rootNode: ast.Node, pos: error.Location
  ): ast.Node | astVisitor.FindFailure => {
    // Special case. Make sure that if the cursor is beyond the range
    // of text of the last good parse, we just return the last node.
    // For example, if the user types a `.` character at the end of
    // the document, the document now fails to parse, and the cursor
    // is beyond the range of text of the last good parse.
    const endLoc = rootNode.loc.end;
    if (endLoc.line < pos.line || (endLoc.line == pos.line && endLoc.column < pos.column)) {
      pos = endLoc;
    }

    const visitor = new astVisitor.CursorVisitor(pos, rootNode);
    visitor.visit();
    const tightestNode = visitor.nodeAtPosition;
    return tightestNode;
  }
}

//
// Utilities.
//

const envToSuggestions = (env: ast.Environment): service.CompletionInfo[] => {
    return env.map((value: ast.LocalBind | ast.FunctionParam, key: string) => {
      // TODO: Fill in documentation later. This might involve trying
      // to parse function comment to get comments about different
      // parameters.
      return <service.CompletionInfo>{
        label: key,
        kind: "Variable",
      };
    })
    .toArray();
}
