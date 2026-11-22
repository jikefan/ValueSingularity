import '@testing-library/jest-dom/vitest'

const NativeRequest = globalThis.Request

class RelativeUrlRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const resolved =
      typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input
    super(resolved, init)
  }
}

globalThis.Request = RelativeUrlRequest

if (typeof globalThis.ResizeObserver === 'undefined') {
  class MockResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  globalThis.ResizeObserver = MockResizeObserver
}
