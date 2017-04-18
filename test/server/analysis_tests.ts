'use strict';
import { expect, assert } from 'chai';
import * as mocha from 'mocha';
import * as os from 'os';

import * as analyze from '../../server/ast/analyzer';
import * as ast from '../../server/ast/schema';

const dataDir = `${__dirname}/../../../test/data`;
const jsonnetServer = "/Users/alex/src/go/src/github.com/google/go-jsonnet/main";

const makeLocation = (line: number, column: number): ast.Location => {
  return { line: line, column: column };
}

const assertLocationRange = (
  lr: ast.LocationRange, startLine: number, startCol: number, endLine: number,
  endCol: number
): void => {
  assert.equal(lr.begin.line, startLine);
  assert.equal(lr.begin.column, startCol);
  assert.equal(lr.end.line, endLine);
  assert.equal(lr.end.column, endCol);
}

describe("Analyzer tests", () => {
  it("Searching for a node by position", () => {
    const analyzer = new analyze.Analyzer();
    analyzer.command = jsonnetServer;

    const rootNode = analyzer.parseJsonnetFile(
      `${dataDir}/simple-nodes.jsonnet`);

    //
    // First property.
    //

    // Property.
    {
      const property1Id = <ast.Identifier>analyzer.getNodeAtPositionFromAst(
        rootNode, makeLocation(2, 5));
      assert.equal(property1Id.nodeType, "IdentifierNode");
      assert.equal(property1Id.name, "property1");
      assert.isNotNull(property1Id.parent);
      assertLocationRange(property1Id.locationRange, 2, 3, 2, 12);

      const property1Parent = <ast.ObjectField>property1Id.parent;
      assert.equal(property1Parent.nodeType, "ObjectFieldNode");
      assertLocationRange(property1Parent.locationRange, 2, 3, 2, 17);
    }

    // Value.
    {
      const target1Id = <ast.Identifier>analyzer.getNodeAtPositionFromAst(
        rootNode, makeLocation(2, 14));
      assert.equal(target1Id.nodeType, "IdentifierNode");
      assert.equal(target1Id.name, "foo");
      assert.isNotNull(target1Id.parent);
      assertLocationRange(target1Id.locationRange, 2, 14, 2, 17);

      const target1Parent = <ast.Var>target1Id.parent;
      assert.equal(target1Parent.nodeType, "VarNode");
      assert.isNotNull(target1Parent.parent);
      assertLocationRange(target1Parent.locationRange, 2, 14, 2, 17);

      const target1Grandparent = <ast.ObjectField>target1Parent.parent;
      assert.equal(target1Grandparent.nodeType, "ObjectFieldNode");
      assertLocationRange(target1Grandparent.locationRange, 2, 3, 2, 17);
    }

    //
    // Second property.
    //

    // Target.
    {
      const target2Id = <ast.LiteralNumber>analyzer.getNodeAtPositionFromAst(
        rootNode, makeLocation(3, 15));
      assert.equal(target2Id.nodeType, "LiteralNumberNode");
      assert.equal(target2Id.originalString, "2");
      assert.equal(target2Id.value, 2);
      assert.isNotNull(target2Id.parent);
      assertLocationRange(target2Id.locationRange, 3, 14, 3, 15);

      const target2Parent = <ast.ObjectField>target2Id.parent;
      assert.equal(target2Parent.nodeType, "ObjectFieldNode");
      assertLocationRange(target2Parent.locationRange, 3, 3, 3, 15);
    }
  });
});
