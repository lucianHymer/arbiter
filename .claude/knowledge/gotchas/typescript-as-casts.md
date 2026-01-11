# Gotcha: Avoid TypeScript "as" Casts and "any" Types

**Date discovered:** 2026-01-11

## The Problem

TypeScript `as` casts and `any` types bypass type checking and hide bugs.

## Real Example

The SDK hooks didn't work because we returned `object` and cast with `as Options["hooks"]` - TypeScript couldn't verify the structure was wrong.

## Anti-patterns to Avoid

```typescript
// BAD: Returning object and casting
function createHooks(): object {
  return { ... };
}
const hooks = createHooks() as Options["hooks"];

// BAD: Using any
function process(data: any) { ... }

// BAD: Casting to suppress errors
const result = someValue as SomeType;
```

## Correct Patterns

```typescript
// GOOD: Use actual return types
function createHooks(): Options["hooks"] {
  return { ... };
}

// GOOD: Use unknown with type guards
function process(data: unknown) {
  if (isValidData(data)) {
    // TypeScript now knows the type
  }
}

// GOOD: Fix the underlying type issue
const result: SomeType = properlyTypedValue;
```

## Key Insight

The SDK's types are correct - when we lie to the compiler with `as`, it can't help us find bugs. Trust the type system and fix type errors rather than silencing them.

## Related Files

- src/arbiter.ts
- src/orchestrator.ts
- src/router.ts
