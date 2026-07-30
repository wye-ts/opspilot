import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { createRequestAbortHandle } from "./request-abort-handle";

/**
 * A minimal stand-in for the parts of ServerResponse the handle observes: the
 * two events, and the `writableFinished` flag that distinguishes a clean
 * finish from a socket that died mid-flush.
 *
 * Deliberately not a real ServerResponse. The behaviour under test is entirely
 * about listener bookkeeping and one boolean, and a real response would drag
 * in a socket without making any assertion stronger.
 */
class FakeResponse extends EventEmitter {
  writableFinished = false;
  destroyed = false;

  finish(): void {
    this.writableFinished = true;
    this.emit("finish");
  }

  /** A close that beats the flush — the caller went away. */
  closePrematurely(): void {
    this.writableFinished = false;
    this.emit("close");
  }

  /** The ordinary close that follows a completed response. */
  closeAfterFinish(): void {
    this.writableFinished = true;
    this.emit("close");
  }

  asResponse(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}

describe("createRequestAbortHandle", () => {
  it("does not abort when the response finishes normally", () => {
    // The regression this whole design exists for: an implementation built on
    // request.on("close") aborts here, on every healthy request.
    const response = new FakeResponse();
    const handle = createRequestAbortHandle(response.asResponse());

    response.finish();

    expect(handle.signal.aborted).toBe(false);
  });

  it("aborts when the connection closes before the response is flushed", () => {
    const response = new FakeResponse();
    const handle = createRequestAbortHandle(response.asResponse());

    response.closePrematurely();

    expect(handle.signal.aborted).toBe(true);
  });

  it("does not abort when close follows a completed response", () => {
    const response = new FakeResponse();
    const handle = createRequestAbortHandle(response.asResponse());

    response.finish();
    response.closeAfterFinish();

    expect(handle.signal.aborted).toBe(false);
  });

  it("removes both listeners once settled", () => {
    const response = new FakeResponse();
    createRequestAbortHandle(response.asResponse());

    expect(response.listenerCount("finish")).toBe(1);
    expect(response.listenerCount("close")).toBe(1);

    response.finish();

    expect(response.listenerCount("finish")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
  });

  it("removes both listeners on dispose", () => {
    const response = new FakeResponse();
    const handle = createRequestAbortHandle(response.asResponse());

    handle.dispose();

    expect(response.listenerCount("finish")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
    expect(handle.signal.aborted).toBe(false);
  });

  it("is idempotent — dispose twice, and after an abort, are both no-ops", () => {
    const disposedTwice = new FakeResponse();
    const first = createRequestAbortHandle(disposedTwice.asResponse());
    first.dispose();
    expect(() => first.dispose()).not.toThrow();
    expect(first.signal.aborted).toBe(false);

    const aborted = new FakeResponse();
    const second = createRequestAbortHandle(aborted.asResponse());
    aborted.closePrematurely();
    expect(second.signal.aborted).toBe(true);
    expect(() => second.dispose()).not.toThrow();
    expect(second.signal.aborted).toBe(true);
  });

  it("aborts at most once even if close fires repeatedly", () => {
    const response = new FakeResponse();
    const handle = createRequestAbortHandle(response.asResponse());

    let abortCount = 0;
    handle.signal.addEventListener("abort", () => {
      abortCount += 1;
    });

    response.closePrematurely();
    response.closePrematurely();
    response.closePrematurely();

    expect(abortCount).toBe(1);
  });

  it("aborts immediately when the response was already destroyed before construction", () => {
    // A caller can disconnect between the request body being accepted and the
    // controller reaching this call — the `close` event already fired, so
    // there is no future event for the listener to catch. The handle must
    // reconcile this from current state instead of waiting forever.
    const response = new FakeResponse();
    response.destroyed = true;

    const handle = createRequestAbortHandle(response.asResponse());

    expect(handle.signal.aborted).toBe(true);
    expect(response.listenerCount("finish")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
  });

  it("does not abort, and retains no listeners, when the response was already finished before construction", () => {
    const response = new FakeResponse();
    response.writableFinished = true;

    const handle = createRequestAbortHandle(response.asResponse());

    expect(handle.signal.aborted).toBe(false);
    expect(response.listenerCount("finish")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
  });

  it("does not abort twice when already destroyed at construction and close then fires again", () => {
    // Regression guard for the attach-then-check ordering: the reconciliation
    // check must not race with a listener that also observes the same
    // transition.
    const response = new FakeResponse();
    response.destroyed = true;

    const handle = createRequestAbortHandle(response.asResponse());

    let abortCount = 0;
    handle.signal.addEventListener("abort", () => {
      abortCount += 1;
    });

    response.closePrematurely();

    expect(abortCount).toBe(0);
    expect(handle.signal.aborted).toBe(true);
  });

  it("does not abort after dispose, even if the connection then drops", () => {
    // The handler has returned and the caller has stopped caring; a late
    // disconnect must not retroactively mark the run cancelled.
    const response = new FakeResponse();
    const handle = createRequestAbortHandle(response.asResponse());

    handle.dispose();
    response.closePrematurely();

    expect(handle.signal.aborted).toBe(false);
  });
});
