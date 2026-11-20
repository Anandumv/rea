import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticSlotAtPath } from "./javascriptSemanticSlots.js";
import {
  resolveSemanticBindingState,
  semanticDestructuringCompletionFacts,
  semanticDestructuringCompletionKey,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { traverseJavaScriptValueAst } from "./javascriptSemanticTraversal.js";
import { evaluateSemanticExpression } from "./javascriptSemanticValues.js";
import type { JavaScriptSemanticValue } from "./javascriptSemanticValueTypes.js";

type CompletionSlot = {
  readonly presence: "present" | "absent" | "unknown";
  readonly value?: JavaScriptSemanticValue;
};

/**
 * Record whether each destructuring binding is reached.
 * An earlier nested pattern that is proven to throw leaves later bindings
 * unreached. Both the binding-value pass and the object collector read this
 * map, so neither can publish a resolved result the other rejected.
 */
export const indexSemanticDestructuringCompletion = (
  state: JavaScriptSemanticAnalysisState,
): void => {
  const facts = semanticDestructuringCompletionFacts(state);
  if (facts.indexed) return;
  facts.indexed = true;
  traverseJavaScriptValueAst(state.program, state.erasedSyntaxNodes, {
    enter: (node) => {
      if (
        t.isVariableDeclarator(node) &&
        node.init != null &&
        nestedPatternPrecedesLaterBinding(node.id)
      )
        completePattern(node.id, node.init, state);
      else if (
        t.isAssignmentExpression(node, { operator: "=" }) &&
        nestedPatternPrecedesLaterBinding(node.left)
      )
        completePattern(node.left, node.right, state);
    },
  });
};

const completePattern = (
  pattern: t.Node,
  source: t.Node,
  state: JavaScriptSemanticAnalysisState,
): void => {
  const root = patternNode(pattern);
  if (root === undefined) return;
  const value = evaluateSemanticExpression(source, state, source);
  walkPattern(root, { presence: "present", value }, [], state, false);
};

const patternNode = (
  node: t.Node,
): t.ObjectPattern | t.ArrayPattern | undefined => {
  const current = unwrapJavaScriptExpression(node).node;
  return t.isObjectPattern(current) || t.isArrayPattern(current)
    ? current
    : undefined;
};

const isNestedPattern = (node: t.Node): boolean => {
  const current = unwrapJavaScriptExpression(node).node;
  if (t.isAssignmentPattern(current)) return isNestedPattern(current.left);
  if (t.isRestElement(current)) return isNestedPattern(current.argument);
  return t.isObjectPattern(current) || t.isArrayPattern(current);
};

const containsBindingTarget = (node: t.Node): boolean => {
  const current = unwrapJavaScriptExpression(node).node;
  if (t.isIdentifier(current)) return true;
  if (t.isAssignmentPattern(current))
    return containsBindingTarget(current.left);
  if (t.isRestElement(current)) return containsBindingTarget(current.argument);
  if (t.isObjectPattern(current))
    return current.properties.some((property) =>
      containsBindingTarget(
        t.isRestElement(property) ? property.argument : property.value,
      ),
    );
  if (t.isArrayPattern(current))
    return current.elements.some(
      (element) => element !== null && containsBindingTarget(element),
    );
  return false;
};

/** True when a nested pattern is followed by a binding it can prevent. */
const nestedPatternPrecedesLaterBinding = (pattern: t.Node): boolean => {
  const current = unwrapJavaScriptExpression(pattern).node;
  if (t.isObjectPattern(current)) {
    let nested = false;
    for (const property of current.properties) {
      const value = t.isRestElement(property)
        ? property.argument
        : property.value;
      if (nested && containsBindingTarget(value)) return true;
      if (nestedPatternPrecedesLaterBinding(value)) return true;
      if (isNestedPattern(value)) nested = true;
    }
    return false;
  }
  if (t.isArrayPattern(current)) {
    let nested = false;
    for (const element of current.elements) {
      if (element === null) continue;
      if (nested && containsBindingTarget(element)) return true;
      if (nestedPatternPrecedesLaterBinding(element)) return true;
      if (isNestedPattern(element)) nested = true;
    }
    return false;
  }
  if (t.isAssignmentPattern(current))
    return nestedPatternPrecedesLaterBinding(current.left);
  if (t.isRestElement(current))
    return nestedPatternPrecedesLaterBinding(current.argument);
  return false;
};

const walkPattern = (
  node: t.Node,
  slot: CompletionSlot,
  path: readonly (string | number | null)[],
  state: JavaScriptSemanticAnalysisState,
  abrupt: boolean,
): boolean => {
  const current = unwrapJavaScriptExpression(node).node;
  if (abrupt) {
    markTargets(current, path, state, true);
    return true;
  }
  if (t.isAssignmentPattern(current)) {
    if (slot.presence !== "absent")
      return walkPattern(current.left, slot, path, state, false);
    // Only undefined selects the default. null still enters the nested pattern.
    // A default that merely might throw (an assignment, a call) is not a proven
    // abrupt completion, so later bindings stay reachable.
    if (expressionMayThrow(current.right))
      return walkPattern(
        current.left,
        { presence: "unknown" },
        path,
        state,
        false,
      );
    return walkPattern(
      current.left,
      {
        presence: "present",
        value: evaluateSemanticExpression(current.right, state, current.right),
      },
      path,
      state,
      false,
    );
  }
  if (t.isObjectPattern(current)) {
    if (provenNullish(slot)) {
      markTargets(current, path, state, true);
      return true;
    }
    let stopped = false;
    for (const property of current.properties) {
      if (t.isRestElement(property)) {
        markTargets(property.argument, path, state, stopped);
        continue;
      }
      const name = semanticStaticPropertyKey(property.key, property.computed);
      const childPath = [...path, name];
      if (stopped) {
        markTargets(property.value, childPath, state, true);
        continue;
      }
      stopped = walkPattern(
        property.value,
        propertySlot(slot, name),
        childPath,
        state,
        false,
      );
    }
    return stopped;
  }
  if (t.isArrayPattern(current)) {
    if (provenNullish(slot) || provenNonIterablePrimitive(slot)) {
      markTargets(current, path, state, true);
      return true;
    }
    const items = slot.value?.status === "array" ? slot.value.items : undefined;
    let stopped = false;
    current.elements.forEach((element, index) => {
      if (element === null) return;
      const childPath = [...path, index];
      if (stopped) {
        markTargets(
          t.isRestElement(element) ? element.argument : element,
          t.isRestElement(element) ? path : childPath,
          state,
          true,
        );
        return;
      }
      if (t.isRestElement(element)) {
        markTargets(element.argument, path, state, false);
        return;
      }
      const item = items?.[index];
      const child: CompletionSlot =
        item === undefined
          ? { presence: "unknown" }
          : {
              presence:
                item.presence === "present"
                  ? "present"
                  : item.presence === "absent"
                    ? "absent"
                    : "unknown",
              value: item.value,
            };
      stopped = walkPattern(element, child, childPath, state, false);
    });
    return stopped;
  }
  if (t.isIdentifier(current)) recordTarget(current, path, state, false);
  else if (t.isRestElement(current))
    return walkPattern(current.argument, slot, path, state, false);
  return false;
};

const markTargets = (
  node: t.Node,
  path: readonly (string | number | null)[],
  state: JavaScriptSemanticAnalysisState,
  abrupt: boolean,
): void => {
  const current = unwrapJavaScriptExpression(node).node;
  if (t.isIdentifier(current)) {
    recordTarget(current, path, state, abrupt);
    return;
  }
  if (t.isAssignmentPattern(current)) {
    markTargets(current.left, path, state, abrupt);
    return;
  }
  if (t.isRestElement(current)) {
    markTargets(current.argument, path, state, abrupt);
    return;
  }
  if (t.isObjectPattern(current)) {
    for (const property of current.properties) {
      if (t.isRestElement(property))
        markTargets(property.argument, path, state, abrupt);
      else
        markTargets(
          property.value,
          [...path, semanticStaticPropertyKey(property.key, property.computed)],
          state,
          abrupt,
        );
    }
    return;
  }
  if (t.isArrayPattern(current))
    current.elements.forEach((element, index) => {
      if (element === null) return;
      if (t.isRestElement(element))
        markTargets(element.argument, path, state, abrupt);
      else markTargets(element, [...path, index], state, abrupt);
    });
};

const recordTarget = (
  identifier: t.Identifier,
  path: readonly (string | number | null)[],
  state: JavaScriptSemanticAnalysisState,
  abrupt: boolean,
): void => {
  const binding = resolveSemanticBindingState(
    state,
    identifier,
    identifier.name,
  );
  if (binding === undefined) return;
  const reached = semanticDestructuringCompletionFacts(state).reached;
  const key = semanticDestructuringCompletionKey(binding.bindingId, path);
  if (!reached.has(key)) reached.set(key, !abrupt);
};

const propertySlot = (
  slot: CompletionSlot,
  name: string | null,
): CompletionSlot => {
  if (name === null || slot.presence !== "present" || slot.value === undefined)
    return { presence: "unknown" };
  const selected = semanticSlotAtPath(slot.value, [name]);
  if (selected.presence === "present")
    return { presence: "present", value: selected.value };
  if (selected.presence === "absent")
    return { presence: "absent", value: selected.value };
  return { presence: "unknown", value: selected.value };
};

/** null and a missing property are undefined to a nested pattern. */
const provenNullish = (slot: CompletionSlot): boolean => {
  if (slot.presence === "absent") return true;
  if (slot.presence !== "present" || slot.value === undefined) return false;
  const { value } = slot;
  if (value.status === "literal") return value.value === null;
  return (
    value.status === "union" &&
    value.values.length > 0 &&
    value.values.every((candidate) => candidate === null)
  );
};

/** Numbers and booleans throw when an array pattern tries to iterate them. */
const provenNonIterablePrimitive = (slot: CompletionSlot): boolean => {
  if (slot.presence !== "present" || slot.value === undefined) return false;
  const { value } = slot;
  if (value.status === "literal")
    return typeof value.value === "number" || typeof value.value === "boolean";
  return (
    value.status === "union" &&
    value.values.length > 0 &&
    value.values.every(
      (candidate) =>
        typeof candidate === "number" || typeof candidate === "boolean",
    )
  );
};

/** Defaults that are literals or plain containers do not throw before the pattern. */
const expressionMayThrow = (node: t.Node): boolean => {
  const current = unwrapJavaScriptExpression(node).node;
  if (
    t.isLiteral(current) ||
    t.isIdentifier(current) ||
    t.isThisExpression(current) ||
    t.isFunctionExpression(current) ||
    t.isArrowFunctionExpression(current) ||
    t.isClassExpression(current)
  )
    return false;
  if (t.isUnaryExpression(current) && current.operator !== "delete")
    return expressionMayThrow(current.argument);
  if (t.isObjectExpression(current))
    return current.properties.some((property) => {
      if (t.isSpreadElement(property))
        return expressionMayThrow(property.argument);
      if (property.computed && expressionMayThrow(property.key)) return true;
      return t.isObjectProperty(property) && expressionMayThrow(property.value);
    });
  if (t.isArrayExpression(current))
    return current.elements.some((element) => {
      if (element === null) return false;
      return t.isSpreadElement(element)
        ? expressionMayThrow(element.argument)
        : expressionMayThrow(element);
    });
  return true;
};
