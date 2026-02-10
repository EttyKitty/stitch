// CST Visitor for creating an AST etc
import { Docs, VisitorContext, withCtxKind } from './parser.js';
import {
  Rhs,
  arrayLiteralFromRhs,
  functionFromRhs,
  rhsFrom,
  structLiteralFromRhs,
} from './parser.utility.js';
import { Range, Reference } from './project.location.js';
import { Signifier } from './signifiers.js';
import { normalizeType } from './types.checks.js';
import { WithableType } from './types.js';
import type { GmlSignifierVisitor } from './visitor.js';

export interface AssignmentInfo {
  static?: boolean;
  instance?: boolean;
  local?: boolean;
  docs?: Docs;
  ctx: VisitorContext;
}

export interface AssignmentVariable {
  name: string;
  range: Range;
  container: WithableType;
}

/**
 * Handles the assignment of a value to a variable, managing signifier creation,
 * reference tracking, and type inference.
 */
export function assignVariable(
  visitor: GmlSignifierVisitor,
  variable: AssignmentVariable,
  rawRhs: Rhs,
  info: AssignmentInfo,
) {
  const rhs = rhsFrom(rawRhs);
  const fullScope = visitor.PROCESSOR.fullScope;
  const inDefinitiveSelf = variable.container === fullScope.definitiveSelf;

  // 1. Find or Create the Signifier
  let signifier = variable.container.getMember(variable.name);
  let ref: Reference | undefined;
  let wasUndeclared = false;

  if (!signifier) {
    wasUndeclared = true;

    if (variable.container !== fullScope.global) {
      const parent = variable.container as any;
      const isAnonymousStruct = parent.kind === 'Struct' && !parent.name;

      if (!inDefinitiveSelf && !info.local && !info.static && !isAnonymousStruct) {
        visitor.PROCESSOR.addDiagnostic(
          'UNDECLARED_GLOBAL_REFERENCE',
          variable.range,
          `Variable '${variable.name}' is being implicitly created.`,
        );
      }
      signifier = variable.container.addMember(variable.name);
    } else {
      visitor.PROCESSOR.addDiagnostic(
        'UNDECLARED_GLOBAL_REFERENCE',
        variable.range,
        `Variable '${variable.name}' is assigned in global scope but not declared anywhere.`,
      );
    }
  }

  // 2. Update Metadata and References
  if (signifier) {
    // CORE FIX: Always update flags. If these are only set during creation,
    // symbols found via JSDoc or incremental indexing might lack them,
    // causing the diagnostic to skip them.
    signifier.static = !!info.static;
    signifier.instance = !!info.instance || !info.local;
    signifier.local = !!info.local;

    // Determine if this is the primary definition or a subsequent write
    if (!signifier.def) {
      wasUndeclared = true;
      signifier.definedAt(variable.range);
      // Mark as both Definition and Write
      ref = signifier.addRef(variable.range, true, true);
    } else {
      // Mark as a Write (not a definition)
      ref = signifier.addRef(variable.range, false, true);
    }

    // Ensure definition is moved to the definitive self (e.g. Constructor/Create) if applicable
    ensureDefinitive(
      variable.container as WithableType,
      visitor.PROCESSOR.currentDefinitiveSelf,
      signifier,
      ref,
    );
  }

  // 3. Handle Right-Hand Side (RHS) logic
  const assignedToFunction = functionFromRhs(rhs);
  const assignedToStructLiteral = structLiteralFromRhs(rhs);
  const assignedToArrayLiteral = arrayLiteralFromRhs(rhs);
  const ctx = { ...info.ctx, docs: info.docs, signifier };

  if (assignedToFunction || assignedToStructLiteral || assignedToArrayLiteral) {
    if (assignedToFunction) {
      ctx.self = variable.container;
      visitor.functionExpression(assignedToFunction, ctx);
    } else if (assignedToStructLiteral) {
      visitor.structLiteral(assignedToStructLiteral, ctx);
    } else if (assignedToArrayLiteral) {
      visitor.arrayLiteral(assignedToArrayLiteral, ctx);
    }
  } else if (rhs) {
    const inferredType = normalizeType(
      visitor.assignmentRightHandSide(rhs, withCtxKind(ctx, 'assignment')),
      visitor.PROCESSOR.project.types,
    );
    const forceOverride = info.docs?.jsdoc.kind === 'type';

    if (signifier && (!signifier.isTyped || wasUndeclared || forceOverride)) {
      if (info.docs) {
        signifier.describe(info.docs.jsdoc.description);
        signifier.setType(
          info.docs.type.length ? info.docs.type : inferredType,
        );
      } else if (inferredType) {
        signifier.setType(inferredType);
      }
    } else if (signifier && !signifier.isTyped) {
      signifier.setType(visitor.ANY);
    }
  }

  if (signifier && ref) {
    return {
      item: signifier,
      ref: ref,
    };
  }
  return;
}

export function ensureDefinitive(
  self: WithableType,
  currentDefinitiveSelf: WithableType | undefined,
  member: Signifier,
  ref: Reference,
) {
  if (!currentDefinitiveSelf) return;
  // If this variable comes from a non-definitive declaration,
  // and *would* be definitive here, then we need to update it.
  const inDefinitiveSelf = currentDefinitiveSelf === self;
  const isSelfOwned = self.getMember(member.name, true) === member;
  if (isSelfOwned && !member.definitive && inDefinitiveSelf) {
    member.definitive = true;
    // Ensure the definition is HERE
    member.unsetDef();
    member.definedAt(ref);
    for (const otherRef of member.refs) {
      otherRef.isDef = false; // Unset all other definitions
    }
    ref.isDef = true;
  }
}
