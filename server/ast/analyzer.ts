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

    return new Promise<service.CompletionInfo[]>(
      (resolve, reject) => {
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

        const parse = this.compilerService.cache(
          fileUri, doc.text, doc.version);
        let completions: service.CompletionInfo[] = [];
        if (compiler.isFailedParsedDocument(parse)) {
          // HACK. We should really be propagating the environment
          // down through the parser, not through the visitor
          // afterwards. If we did that, we would be able to use the
          // env of the `rest` node below.
          const lastParse = this.compilerService.getLastSuccess(fileUri);
          if (lastParse == null || compiler.isLexFailure(parse.parse) || parse.parse.parseError.rest == null) {
            resolve([]);
            return;
          }

          const nodeAtPos = this.getNodeAtPositionFromAst(
            lastParse.parse, cursorLoc);

          // Hook up `parent` and `env` into `rest` node.
          const rest = parse.parse.parseError.rest;
          const v = new astVisitor.DeserializingVisitor();
          v.Visit(rest, nodeAtPos, <ast.Environment>nodeAtPos.env);

          const resolved = this.resolveIndirections(rest);
          if (resolved == null) {
            resolve([]);
          } else {
            resolve(this.completableFields(resolved));
          }
          return;
        } else {
          const nodeAtPos = this.getNodeAtPositionFromAst(
            parse.parse, cursorLoc);

          resolve(this.completionsFromIdentifier(nodeAtPos));
        }
      });
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

  private completionsFromIdentifier = (
    node: ast.Node
  ): service.CompletionInfo[] => {
    //
    // We suggest completions only for `Identifier` nodes that are in
    // specific places in the AST. In particular, we would suggest a
    // completion if the identifier is a:
    //
    // 1. Variable references, i.e., identifiers that reference
    //    specific variables, that are in scope.
    // 2. Identifiers that are part of an index expression, e.g.,
    //    `foo.bar`.
    //
    // Note that requiring `node` to be an `Identifier` does
    // disqualify autocompletions in places like comments or strings.
    //

    // Only suggest completions if the node is an identifier.
    if (!ast.isIdentifier(node)) {
      return [];
    }

    // Document root. Give suggestions from the environment if we have
    // them. In a well-formed Jsonnet AST, this should not return
    // valid responses, but return from the environment in case the
    // tree parent was garbled somehow.
    const parent = node.parent;
    if (parent == null) {
      return node.env && envToSuggestions(node.env) || [];
    }

    const resolved = this.resolveIndirections(parent);
    if (resolved == null) {
      return node.env && envToSuggestions(node.env) || [];
    }

    return this.completableFields(resolved);
  }

  private completableFields = (
    resolved: ast.Node
  ): service.CompletionInfo[] => {
    // Attempt to get all the possible fields we could suggest. If the
    // resolved item is an `ObjectNode`, just use its fields; if it's
    // a mixin of two objects, merge them and use the merged fields
    // instead.
    let fields: ast.ObjectFields | null = null;
    const fieldSet = this.createFieldSet(resolved);
    if (fieldSet == null) {
      fields = immutable.List<ast.ObjectField>();
    } else {
      fields = immutable.List(fieldSet.values());
    }

    return fields
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

  private resolveIndirections = (node: ast.Node): ast.Node | null => {
    // This loop will try to "strip out the indirections" of an
    // argument to a mixin. For example, consider the expression
    // `foo1.bar + foo2.bar` in the following example:
    //
    //   local bar1 = {a: 1, b: 2},
    //   local bar2 = {b: 3, c: 4},
    //   local foo1 = {bar: bar1},
    //   local foo2 = {bar: bar2},
    //   useMerged: foo1.bar + foo2.bar,
    //
    // In this case, if we try to resolve `foo1.bar + foo2.bar`, we
    // will first need to resolve `foo1.bar`, and then the value of
    // that resolve, `bar1`, which resolves to an object, and so on.
    //
    // This loop follows these indirections: first, it resolves
    // `foo1.bar`, and then `bar1`, before encountering an object
    // and stopping.

    let resolved: ast.Node | null = node;
    while (true) {
      if (ast.isObjectNode(resolved)) {
        // Found an object. Break.
        break;
      } else if (ast.isBinary(resolved)) {
        // May have found an object mixin. Break.
        break;
      } else if (ast.isVar(resolved)) {
        resolved = this.resolveVar(resolved);
      } else if (ast.isIndex(resolved)) {
        resolved = this.resolveIndex(resolved);
      } else {
        throw new Error(`${ast.renderAsJson(node)}`);
      }

      if (resolved == null) {
        return null;
      }
    }

    return resolved;
  }

  public resolveSymbolAtPosition = (
    fileUri: string, pos: error.Location,
  ): ast.Node | null => {
    const nodeAtPos = this.getNodeAtPosition(fileUri, pos);
    return this.resolveSymbol(nodeAtPos);
  }

  public resolveSymbolAtPositionFromAst = (
    rootNode: ast.Node, pos: error.Location,
  ): ast.Node | null => {
    const nodeAtPos = this.getNodeAtPositionFromAst(rootNode, pos);
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
    if (node == null ) {
      return null;
    }

    if (node.parent && ast.isObjectField(node.parent)) {
      return node.parent;
    }

    switch(node.type) {
      case "IdentifierNode": {
        return this.resolveIdentifier(<ast.Identifier>node);
      }
      case "LocalNode": {
        return node;
      }
      default: {
        return null;
      }
    }
  }

  public resolveIdentifier = (id: ast.Identifier): ast.Node | null => {
    if (id.parent == null) {
      // An identifier with no parent is not a valid Jsonnet file.
      return null;
    }

    switch (id.parent.type) {
      case "VarNode": { return this.resolveVar(<ast.Var>id.parent); }
      case "IndexNode": { return this.resolveIndex(<ast.Index>id.parent); }
      default: {
        // TODO: Support other node types as we need them.
        return null;
      }
    }
  }

  public resolveIndex = (index: ast.Index): ast.Node | null => {
    if (index.target == null) {
      throw new Error(
        `INTERNAL ERROR: Index node must have a target:\n${ast.renderAsJson(index)}`);
    } else if (index.id == null) {
      throw new Error(
        `INTERNAL ERROR: Index node must have a name:\n${ast.renderAsJson(index)}`);
    }

    // Find root target, look up in environment.
    let resolvedTarget: ast.Node;
    switch (index.target.type) {
      case "VarNode": {
        const varNode = <ast.Var>index.target
        const nullableResolved = this.resolveVar(varNode);
        if (nullableResolved == null) {
          return null;
        }

        resolvedTarget = nullableResolved;

        // If the var was pointing at an import, then resolution
        // probably has `local` definitions at the top of the file.
        // Get rid of them, since they are not useful for resolving
        // the index identifier.
        while (ast.isLocal(resolvedTarget)) {
          resolvedTarget = resolvedTarget.body;
        }

        break;
      }
      case "IndexNode": {
        const nullableResolved = this.resolveIndex(<ast.Index>index.target);
        if (nullableResolved == null) {
          return null;
        }
        resolvedTarget = nullableResolved;
        break;
      }
      case "DollarNode": {
        if (index.target.rootObject == null) {
          return null;
        }
        resolvedTarget = index.target.rootObject;
        break;
      }
      default: {
        throw new Error(
          `INTERNAL ERROR: Index node can't have node target of type '${index.target.type}':\n${ast.renderAsJson(index.target)}`);
      }
    }

    switch (resolvedTarget.type) {
      case "ObjectNode": {
        const objectNode = <ast.ObjectNode>resolvedTarget;
        for (let field of objectNode.fields.toArray()) {
          // We're looking for either a field with the id
          if (field.id != null && field.id.name == index.id.name) {
            return field.expr2;
          } else if (field.expr1 == null) {
            // Object field must be identified by an `Identifier` or a
            // string. If those aren't present, skip.
            continue;
          }

          throw new Error(
            `INTERNAL ERROR: Object field is identified by string, but we don't support that yet`);
        }

        return null;
      }
      case "BinaryNode": {
        const fields = this.createFieldSet(resolvedTarget);
        if (fields == null) {
          throw new Error(
            `INTERNAL ERROR: Could not merge fields in binary node:\n${ast.renderAsJson(resolvedTarget)}`);
        }

        const filtered = fields.filter((field: ast.ObjectField) => {
          return field.id != null && index.id != null &&
            field.id.name == index.id.name;
        });

        if (filtered.count() != 1) {
          throw new Error(
            `INTERNAL ERROR: Object contained multiple fields with name '${index.id.name}':\n${ast.renderAsJson(resolvedTarget)}`);
        }

        return filtered.first().expr2;
      }
      default: {
        throw new Error(
          `INTERNAL ERROR: Index node currently requires resolved var to be an object type, but was'${resolvedTarget.type}':\n${ast.renderAsJson(resolvedTarget)}`);
      }
    }
  }

  public resolveVar = (varNode: ast.Var): ast.Node | null => {
    // Look up in the environment, get docs for that definition.
    if (varNode.env == null) {
      throw new Error(
        `INTERNAL ERROR: AST improperly set up, property 'env' can't be null:\n${ast.renderAsJson(varNode)}`);
    } else if (!varNode.env.has(varNode.id.name)) {
      return null;
    }

    return this.resolveFromEnv(varNode.id.name, varNode.env);
  }

  public resolveFromEnv = (
    idName: string, env: ast.Environment
  ): ast.Node | null => {
    const bind = env.get(idName);
    if (bind == null) {
      return null;
    }

    if (ast.isFunctionParam(bind)) {
      // A function param is either a free variable, or it has a
      // default value. We return either way.
      return bind;
    }

    if (bind.body == null) {
      throw new Error(`INTERNAL ERROR: Bind can't have null body:\n${bind}`);
    }

    switch(bind.body.type) {
      case "ImportNode": {
        const importNode = <ast.Import>bind.body;
        const fileToImport =
          filePathToUri(importNode.file, importNode.loc.fileName);
        const {text: docText, version: version} =
          this.documents.get(fileToImport);
        const cached =
          this.compilerService.cache(fileToImport, docText, version);
        if (compiler.isFailedParsedDocument(cached)) {
          return null;
        }

        return cached.parse;
      }
      case "VarNode": {
        return this.resolveVar(<ast.Var>bind.body);
      }
      case "IndexNode": {
        return this.resolveIndex(<ast.Index>bind.body);
      }
      case "BinaryNode": {
        const binaryNode = <ast.Binary>bind.body;
        if (binaryNode.op !== "BopPlus") {
          throw new Error(
            `INTERNAL ERROR: Bind currently can't resolve to binary operations that are not '+':\n${ast.renderAsJson(bind.body)}`);
        }

        return binaryNode;
      }
      default: {
        return bind.body;
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

  private createFieldSet = (
    resolved: ast.Node
  ): immutable.Map<string, ast.ObjectField> | null => {
    // Recursively merge fields if it's another mixin; if it's an
    // object, return fields; else, no fields to return.
    if (ast.isBinary(resolved)) {
      if (resolved.op !== "BopPlus") {
        return null;
      }

      const left = this.resolveIndirections(resolved.left);
      const right = this.resolveIndirections(resolved.right);
      if (left == null || right == null) {
        return null;
      }

      const leftFields = this.createFieldSet(left);
      const rightFields = this.createFieldSet(right);
      return leftFields && rightFields && leftFields.merge(rightFields) || null;
    } else if (ast.isObjectNode(resolved)) {
      return resolved.fields
        .reduce((
          acc: immutable.Map<string, ast.ObjectField>, field: ast.ObjectField
        ) => {
          return field.id != null && acc.set(field.id.name, field) || acc;
        },
        immutable.Map<string, ast.ObjectField>()
      );
    }
    return null;
  }

  public getNodeAtPosition = (
    fileUri: string, pos: error.Location,
  ): ast.Node => {
    const {text: docText, version: version} = this.documents.get(fileUri);
    const cached = this.compilerService.cache(fileUri, docText, version);
    if (compiler.isFailedParsedDocument(cached)) {
      // TODO: Handle this error without an exception.
      const err = compiler.isLexFailure(cached.parse)
        ? cached.parse.lexError.Error()
        : cached.parse.parseError.Error()
      throw new Error(
        `INTERNAL ERROR: Could not cache analysis of file ${fileUri}:\b${err}`);
    }

    return this.getNodeAtPositionFromAst(cached.parse, pos);
  }

  public getNodeAtPositionFromAst = (
    rootNode: ast.Node, pos: error.Location
  ): ast.Node => {
    const visitor = new astVisitor.CursorVisitor(pos);
    visitor.Visit(rootNode, null, ast.emptyEnvironment);
    return visitor.NodeAtPosition;
  }
}

//
// Utilities.
//

const envToSuggestions = (env: ast.Environment): service.CompletionInfo[] => {
    return env.map((value, key) => {
      if (value == null) {
        throw new Error(`INTERNAL ERROR: Value in environment is null`);
      }
      return <service.CompletionInfo>{
        label: key,
        kind: "Variable",
        // TODO: Fill in documentaiton later.
      };
    })
    .toArray();
}

// TODO: Replace this with some sort of URL provider.
const filePathToUri = (filePath: string, currentPath: string): string => {
  let resource = filePath;
  if (!path.isAbsolute(resource)) {
    const resolved = path.resolve(currentPath);
    const absDir = path.dirname(resolved);
    resource = path.join(absDir, filePath);
  }
  return `file://${resource}`;
}
