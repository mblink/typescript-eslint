import type { TSESTree } from '@typescript-eslint/utils';
import { AST_NODE_TYPES } from '@typescript-eslint/utils';
import * as ts from 'typescript';

import * as util from '../util';

enum Usefulness {
  Always = 'always',
  Never = 'will',
  Sometimes = 'may',
  Function = 'function',
}

type Options = [
  {
    ignoredTypeNames?: string[];
    rejectFunctions?: boolean;
  },
];
type MessageIds = 'fnToString' | 'baseToString';

export default util.createRule<Options, MessageIds>({
  name: 'no-base-to-string',
  meta: {
    docs: {
      description:
        'Require `.toString()` to only be called on objects which provide useful information when stringified',
      recommended: 'recommended',
      requiresTypeChecking: true,
    },
    messages: {
      baseToString:
        "'{{name}}' {{certainty}} evaluate to '[object Object]' when stringified.",
      fnToString: "'{{name}}' is a function and should not be stringified.",
    },
    schema: [
      {
        type: 'object',
        properties: {
          ignoredTypeNames: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          rejectFunctions: {
            type: 'boolean',
          },
        },
        additionalProperties: false,
      },
    ],
    type: 'suggestion',
  },
  defaultOptions: [
    {
      ignoredTypeNames: ['Error', 'RegExp', 'URL', 'URLSearchParams'],
      rejectFunctions: false,
    },
  ],
  create(context, [option]) {
    const services = util.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const ignoredTypeNames = option.ignoredTypeNames ?? [];

    function checkExpression(node: TSESTree.Expression, type?: ts.Type): void {
      if (node.type === AST_NODE_TYPES.Literal) {
        return;
      }

      const certainty = collectToStringCertainty(
        type ?? services.getTypeAtLocation(node),
      );
      if (certainty === Usefulness.Always) {
        return;
      }

      if (certainty === Usefulness.Function) {
        context.report({
          data: {
            name: context.getSourceCode().getText(node),
          },
          messageId: 'fnToString',
          node,
        });
        return;
      }

      context.report({
        data: {
          certainty,
          name: context.getSourceCode().getText(node),
        },
        messageId: 'baseToString',
        node,
      });
    }

    function collectToStringCertainty(type: ts.Type): Usefulness {
      const toString = checker.getPropertyOfType(type, 'toString');
      const declarations = toString?.getDeclarations();
      const callSignatures = type.getCallSignatures();
      if (option.rejectFunctions && callSignatures.length > 0) {
        return Usefulness.Function;
      }
      if (!toString || !declarations || declarations.length === 0) {
        return Usefulness.Always;
      }

      // Patch for old version TypeScript, the Boolean type definition missing toString()
      if (
        type.flags & ts.TypeFlags.Boolean ||
        type.flags & ts.TypeFlags.BooleanLiteral
      ) {
        return Usefulness.Always;
      }

      if (ignoredTypeNames.includes(util.getTypeName(checker, type))) {
        return Usefulness.Always;
      }

      if (
        declarations.every(
          ({ parent }) =>
            !ts.isInterfaceDeclaration(parent) || parent.name.text !== 'Object',
        )
      ) {
        return Usefulness.Always;
      }

      if (type.isIntersection()) {
        for (const subType of type.types) {
          const subtypeUsefulness = collectToStringCertainty(subType);

          if (subtypeUsefulness === Usefulness.Always) {
            return Usefulness.Always;
          }
        }

        return Usefulness.Never;
      }

      if (!type.isUnion()) {
        return Usefulness.Never;
      }

      let allSubtypesUseful = true;
      let someSubtypeUseful = false;

      for (const subType of type.types) {
        const subtypeUsefulness = collectToStringCertainty(subType);

        if (subtypeUsefulness !== Usefulness.Always && allSubtypesUseful) {
          allSubtypesUseful = false;
        }

        if (subtypeUsefulness !== Usefulness.Never && !someSubtypeUseful) {
          someSubtypeUseful = true;
        }
      }

      if (allSubtypesUseful && someSubtypeUseful) {
        return Usefulness.Always;
      }

      if (someSubtypeUseful) {
        return Usefulness.Sometimes;
      }

      return Usefulness.Never;
    }

    return {
      'AssignmentExpression[operator = "+="], BinaryExpression[operator = "+"]'(
        node: TSESTree.AssignmentExpression | TSESTree.BinaryExpression,
      ): void {
        const leftType = services.getTypeAtLocation(node.left);
        const rightType = services.getTypeAtLocation(node.right);

        if (util.getTypeName(checker, leftType) === 'string') {
          checkExpression(node.right, rightType);
        } else if (
          util.getTypeName(checker, rightType) === 'string' &&
          node.left.type !== AST_NODE_TYPES.PrivateIdentifier
        ) {
          checkExpression(node.left, leftType);
        }
      },
      'CallExpression > MemberExpression.callee > Identifier[name = "toString"].property'(
        node: TSESTree.Expression,
      ): void {
        const memberExpr = node.parent as TSESTree.MemberExpression;
        checkExpression(memberExpr.object);
      },
      TemplateLiteral(node: TSESTree.TemplateLiteral): void {
        if (node.parent.type === AST_NODE_TYPES.TaggedTemplateExpression) {
          return;
        }
        for (const expression of node.expressions) {
          checkExpression(expression);
        }
      },
    };
  },
});
