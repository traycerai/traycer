const typeBypassRestrictions = [
  {
    selector: ":matches(TSAsExpression, TSTypeAssertion) > TSAnyKeyword",
    message:
      "Do not bypass the type system with `as any`. Define a precise type instead.",
  },
  {
    selector: ":matches(TSAsExpression, TSTypeAssertion) > TSUnknownKeyword",
    message:
      "Do not bypass the type system with `as unknown`. Narrow the value or define an explicit intermediate type instead.",
  },
  {
    selector:
      ':matches(TSAsExpression, TSTypeAssertion)[expression.type="TSAsExpression"], :matches(TSAsExpression, TSTypeAssertion)[expression.type="TSTypeAssertion"]',
    message:
      "Do not chain type assertions. Define an explicit intermediate type instead.",
  },
];

const optionalParameterRestrictions = [
  {
    selector:
      ":matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression, TSDeclareFunction, TSFunctionType, TSMethodSignature, TSCallSignatureDeclaration, TSConstructSignatureDeclaration, TSConstructorType) > :matches(Identifier, ObjectPattern, ArrayPattern)[optional=true], TSParameterProperty > :matches(Identifier, ObjectPattern, ArrayPattern)[optional=true]",
    message:
      "Optional parameters (`?:`) are not allowed. Use an explicit union with `undefined` or `null` instead.",
  },
];

const requiredArgumentRestrictions = [
  {
    selector:
      ":matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression, MethodDefinition, TSDeclareFunction) > AssignmentPattern, TSParameterProperty > AssignmentPattern",
    message:
      "Default parameter values are not allowed. Require callers to pass every argument explicitly.",
  },
  {
    // A rest parameter owns its annotation; its Identifier argument does not.
    // Selecting Identifier[typeAnnotation] left both tuple/union arms inert.
    selector:
      ":matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression, MethodDefinition, TSDeclareFunction, TSFunctionType, TSMethodSignature, TSCallSignatureDeclaration, TSConstructSignatureDeclaration, TSConstructorType) > RestElement[typeAnnotation.typeAnnotation.type='TSTupleType'], :matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression, MethodDefinition, TSDeclareFunction, TSFunctionType, TSMethodSignature, TSCallSignatureDeclaration, TSConstructSignatureDeclaration, TSConstructorType) > RestElement[typeAnnotation.typeAnnotation.type='TSUnionType']",
    message:
      "Do not use rest-parameter tuple or union shims to emulate optional arguments. Define explicit parameters and require callers to pass `undefined` or `null` when needed.",
  },
];

const explicitTypeReferenceRestrictions = [
  {
    // Utility applications always carry type arguments. A bare type parameter
    // named ReturnType is different: Tiptap requires Commands<ReturnType> in
    // module augmentations, and declaration merging requires that exact name.
    // Narrowing to applications keeps every ReturnType<typeof ...> violation.
    selector:
      "TSTypeReference[typeName.name='ReturnType']:has(TSTypeParameterInstantiation)",
    message:
      "Do not rely on `ReturnType<...>`. Define and use the concrete return type explicitly.",
  },
];

export {
  typeBypassRestrictions,
  optionalParameterRestrictions,
  requiredArgumentRestrictions,
  explicitTypeReferenceRestrictions,
};

export const traycerTypeSafetyRestrictions = [
  ...typeBypassRestrictions,
  ...optionalParameterRestrictions,
  ...requiredArgumentRestrictions,
  ...explicitTypeReferenceRestrictions,
];
