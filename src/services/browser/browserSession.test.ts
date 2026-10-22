import { test as bunTest } from 'bun:test'
/**
 * Regression tests for human-active-tab synchronization.
 *
 * Run: bun run src/services/browser/browserSession.test.ts
 */

import {
  buildTabActivityScript,
  getBrowserSession,
  shouldAdoptTabActivity,
  type BrowserSessionService,
  type ObservationDiff,
  type TabActivityProbe,
} from "./browserSession.js";
import type {
  InteractiveElement,
  ObservedState,
  ReadResult,
} from "./pageScripts.js";
import {
  READ_DEFAULT_MAX_CHARS,
  READ_MAX_CHARS_PER_CALL,
  READ_MAX_CHARS_PER_DOCUMENT,
  READ_MAX_CHARS_PER_SESSION,
  SUMMARY_INPUT_MAX_CHARS,
} from "./readLimits.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, hint: string): void {
  if (!condition) throw new Error(hint);
}

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error: unknown) {
    failed++;
    console.log(
      `  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error: unknown) {
    failed++;
    console.log(
      `  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface SendCall {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface FakeClient {
  isOpen: boolean;
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<T>;
}

function fakeClient(
  handler: (call: SendCall) => unknown | Promise<unknown>,
): FakeClient {
  return {
    isOpen: true,
    async send<T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ): Promise<T> {
      return (await handler({ method, params, sessionId })) as T;
    },
  };
}

type SessionHarness = {
  client?: FakeClient;
  activeTargetId?: string;
  lastKnownUrl?: string;
  readPage: BrowserSessionService["readPage"];
  readForSummary: BrowserSessionService["readForSummary"];
  noteSummaryOutput: BrowserSessionService["noteSummaryOutput"];
  getCachedSummary: BrowserSessionService["getCachedSummary"];
  noteSummaryDigest: BrowserSessionService["noteSummaryDigest"];
  getObservationDiff: BrowserSessionService["getObservationDiff"];
  lastObservedState?: ObservedState;
  lastObservedTargetId?: string;
  lastObservationDiff?: ObservationDiff;
  activityBindingName: string;
  sessions: Map<string, string>;
  sessionToTarget: Map<string, string>;
  sessionPromises: Map<string, Promise<string>>;
  fullyPreparedTargets: Set<string>;
  activityTargets: Set<string>;
  sessionNotes: string[];
  ensureTargetSession(targetId: string): Promise<string>;
  handleTabActivityBinding(
    params: { name?: string },
    sessionId?: string,
  ): Promise<void>;
  selectTab: BrowserSessionService["selectTab"];
};

const SessionCtor = getBrowserSession()
  .constructor as unknown as new () => BrowserSessionService;
const freshSession = () =>
  new SessionCtor() as unknown as SessionHarness;

async function main(): Promise<void> {
  console.log("tab activity script:");

  test("uses trusted events and focus verification without polling", () => {
    const script = buildTabActivityScript("__testBinding");
    assert(script.includes("event.isTrusted !== true"), "must reject synthetic events");
    assert(script.includes("document.hasFocus()"), "must require document focus");
    assert(
      script.includes("document.visibilityState !== 'visible'"),
      "must require a visible document",
    );
    assert(script.includes("previous.cleanup()"), "must clean up its prior listeners");
    assert(!script.includes("setInterval"), "must not introduce a polling loop");
  });

  console.log("shouldAdoptTabActivity:");

  const visibleFocus: TabActivityProbe = {
    focused: true,
    visible: true,
  };
  test("adopts a different focused and visible tab", () => {
    assert(
      shouldAdoptTabActivity("tab-a", "tab-b", visibleFocus),
      "focused candidate should be adopted",
    );
  });
  test("rejects the current, hidden, and unfocused tabs", () => {
    assert(
      !shouldAdoptTabActivity("tab-a", "tab-a", visibleFocus),
      "current tab is not a switch",
    );
    assert(
      !shouldAdoptTabActivity("tab-a", "tab-b", {
        focused: true,
        visible: false,
      }),
      "hidden tab must be rejected",
    );
    assert(
      !shouldAdoptTabActivity("tab-a", "tab-b", {
        focused: false,
        visible: true,
      }),
      "unfocused tab must be rejected",
    );
  });

  console.log("explicit tab switching:");

  await testAsync("activates the real browser tab before adopting it", async () => {
    const calls: SendCall[] = [];
    const session = freshSession();
    session.activeTargetId = "tab-a";
    session.sessions.set("tab-b", "session-b");
    session.sessionToTarget.set("session-b", "tab-b");
    session.fullyPreparedTargets.add("tab-b");
    session.client = fakeClient((call) => {
      calls.push(call);
      if (call.method === "Target.getTargets") {
        return {
          targetInfos: [
            {
              targetId: "tab-a",
              type: "page",
              title: "A",
              url: "https://a.test/",
            },
            {
              targetId: "tab-b",
              type: "page",
              title: "B",
              url: "https://b.test/",
            },
          ],
        };
      }
      return {};
    });

    await session.selectTab(1);

    const activation = calls.find((call) => call.method === "Target.activateTarget");
    assert(
      activation?.params?.targetId === "tab-b",
      `visible tab was not activated: ${JSON.stringify(calls)}`,
    );
    assert(session.activeTargetId === "tab-b", "internal active target must follow");
  });

  console.log("human activity handoff:");

  await testAsync("follows a focused tab and emits one handoff note", async () => {
    const session = freshSession();
    session.activeTargetId = "tab-a";
    session.sessions.set("tab-b", "session-b");
    session.sessionToTarget.set("session-b", "tab-b");
    session.client = fakeClient((call) => {
      if (call.method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              focused: true,
              visible: true,
              url: "https://b.test/",
              title: "Focused B",
            },
          },
        };
      }
      return {};
    });

    await session.handleTabActivityBinding(
      { name: session.activityBindingName },
      "session-b",
    );
    await session.handleTabActivityBinding(
      { name: session.activityBindingName },
      "session-b",
    );

    assert(session.activeTargetId === "tab-b", "focused tab must become active");
    assert(session.sessionNotes.length === 1, "handoff should be announced once");
    assert(
      session.sessionNotes[0]?.includes("Focused B") === true,
      `handoff note lacks the tab label: ${session.sessionNotes[0]}`,
    );
  });

  await testAsync("ignores a forged/background activity report", async () => {
    const session = freshSession();
    session.activeTargetId = "tab-a";
    session.sessions.set("tab-b", "session-b");
    session.sessionToTarget.set("session-b", "tab-b");
    session.client = fakeClient((call) => {
      if (call.method === "Runtime.evaluate") {
        return {
          result: {
            value: { focused: false, visible: true, url: "https://b.test/" },
          },
        };
      }
      return {};
    });

    await session.handleTabActivityBinding(
      { name: session.activityBindingName },
      "session-b",
    );

    assert(session.activeTargetId === "tab-a", "background tab must not hijack focus");
    assert(session.sessionNotes.length === 0, "rejected report must stay silent");
  });

  console.log("read budget:");

  function readSession(url = "https://read.test/") {
    const expressions: string[] = [];
    const session = freshSession();
    session.activeTargetId = "tab-read";
    session.lastKnownUrl = url;
    session.sessions.set("tab-read", "session-read");
    session.fullyPreparedTargets.add("tab-read");
    session.client = fakeClient((call) => {
      if (call.method === "Runtime.evaluate") {
        const expression = String(call.params?.expression ?? "");
        expressions.push(expression);
        const match = expression.match(
          /readPage\((?:null|"[^"]*"), \d+, (\d+), /,
        );
        const budget = match ? Number(match[1]) : READ_DEFAULT_MAX_CHARS;
        const result: ReadResult = {
          success: true,
          url,
          title: "Read",
          content: "x".repeat(budget),
          total: 1_000_000,
          offset: 0,
          complete: false,
        };
        return { result: { value: result } };
      }
      return {};
    });
    return { session, expressions };
  }

  await testAsync("read defaults to the smaller page slice", async () => {
    const { session, expressions } = readSession();
    await session.readPage({});
    const last = expressions.at(-1) ?? "";
    assert(
      last.includes(`readPage(null, 0, ${READ_DEFAULT_MAX_CHARS}, null, null)`),
      last,
    );
  });

  await testAsync("maxChars cannot exceed the per-call ceiling", async () => {
    const { session, expressions } = readSession();
    await session.readPage({ maxChars: 999_999 });
    const last = expressions.at(-1) ?? "";
    assert(last.includes(`, ${READ_MAX_CHARS_PER_CALL},`), last);
  });

  await testAsync("stops paging one document after its budget", async () => {
    const { session, expressions } = readSession();
    const perRead = READ_MAX_CHARS_PER_CALL;
    const reads = Math.ceil(READ_MAX_CHARS_PER_DOCUMENT / perRead);
    for (let i = 0; i < reads; i++) {
      const result = await session.readPage({ maxChars: perRead });
      assert(result.success, `read ${i}: ${JSON.stringify(result)}`);
    }
    const evaluations = expressions.length;
    const refused = await session.readPage({ maxChars: perRead });
    assert(
      !refused.success && refused.reason === "read_budget",
      JSON.stringify(refused),
    );
    assert(
      expressions.length === evaluations,
      "a refused read must not evaluate the page again",
    );
    assert(
      (refused.error ?? "").includes("page"),
      String(refused.error),
    );
  });

  await testAsync("session budget spans documents", async () => {
    const { session, expressions } = readSession();
    const readsPerDocument = Math.ceil(
      READ_MAX_CHARS_PER_DOCUMENT / READ_MAX_CHARS_PER_CALL,
    );
    const documents = Math.ceil(
      READ_MAX_CHARS_PER_SESSION / READ_MAX_CHARS_PER_DOCUMENT,
    );
    for (let document = 0; document < documents; document++) {
      session.lastKnownUrl = `https://read.test/${document}`;
      for (let i = 0; i < readsPerDocument; i++) {
        const result = await session.readPage({
          maxChars: READ_MAX_CHARS_PER_CALL,
        });
        assert(
          result.success,
          `document ${document} read ${i}: ${JSON.stringify(result)}`,
        );
      }
    }
    session.lastKnownUrl = "https://read.test/next";
    const refused = await session.readPage({ maxChars: READ_MAX_CHARS_PER_CALL });
    assert(
      !refused.success && refused.reason === "read_budget",
      JSON.stringify(refused),
    );
    assert(
      (refused.error ?? "").includes("browser session"),
      String(refused.error),
    );
    assert(
      expressions.length === documents * readsPerDocument,
      `${expressions.length} evaluations`,
    );
  });

  await testAsync("a query is threaded into the page read", async () => {
    const { session, expressions } = readSession();
    await session.readPage({ query: "reinforcement learning" });
    const last = expressions.at(-1) ?? "";
    assert(last.includes(', "reinforcement learning")'), last.slice(-160));
  });

  await testAsync("a repeated query read is served from the extraction cache", async () => {
    let evaluations = 0;
    const session = freshSession();
    session.activeTargetId = "tab-cache";
    session.lastKnownUrl = "https://cache.test/";
    session.sessions.set("tab-cache", "session-cache");
    session.fullyPreparedTargets.add("tab-cache");
    session.client = fakeClient((call) => {
      if (call.method === "Runtime.evaluate") {
        evaluations++;
        const result: ReadResult = {
          success: true,
          url: "https://cache.test/",
          title: "Cache",
          content: "matched passage ".repeat(200),
          total: 40_000,
          offset: 0,
          complete: true,
          query: "passage",
          matches: 2,
        };
        return { result: { value: result } };
      }
      return {};
    });

    const first = await session.readPage({ query: "passage" });
    assert(first.success && first.cached !== true, JSON.stringify(first));
    const second = await session.readPage({ query: "passage" });
    assert(second.success && second.cached === true, JSON.stringify(second));
    assert(evaluations === 1, `page evaluated ${evaluations} times`);
    assert((second.content ?? "").includes("[cached"), String(second.content));
    assert((second.content ?? "").length < 1_000, String(second.content?.length));

    const refreshed = await session.readPage({ query: "passage", refresh: true });
    assert(refreshed.cached !== true, "refresh must bypass the cache");
    assert(evaluations === 2, `page evaluated ${evaluations} times after refresh`);
  });

  await testAsync("summary digests are cached by page and query", async () => {
    const session = freshSession();
    const key = { selector: null, query: "install", maxChars: 3_000 };
    assert(session.getCachedSummary(key) === undefined, "cache must start empty");
    session.noteSummaryDigest(key, "digest text", "https://docs.test/", "Docs");
    const hit = session.getCachedSummary(key);
    assert(hit?.digest === "digest text", JSON.stringify(hit));
    assert(hit?.title === "Docs", JSON.stringify(hit));
    assert(
      session.getCachedSummary({ ...key, query: "remove" }) === undefined,
      "a different query must miss",
    );
  });

  await testAsync("observation diffs list only added, changed, and removed elements", async () => {
    const session = freshSession();
    session.activeTargetId = "tab-diff";
    const element = (
      id: number,
      text: string,
      extra: Partial<InteractiveElement> = {},
    ): InteractiveElement => ({
      id,
      tag: "button",
      text,
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      ...extra,
    });
    const observed = (elements: InteractiveElement[]): ObservedState => ({
      url: "https://diff.test/",
      title: "Diff",
      text_sample: "",
      interactive_elements: elements,
    });

    const first = observed([
      element(1, "Save"),
      element(2, "Docs"),
      element(4, "Settings"),
      element(5, "Help"),
    ]);
    assert(
      (session as any).computeObservationDiff(first) === undefined,
      "the first observation has no baseline",
    );
    session.lastObservedState = first;
    session.lastObservedTargetId = "tab-diff";

    const second = observed([
      element(1, "Save", { value: "draft" }),
      element(3, "Publish"),
      element(4, "Settings"),
      element(5, "Help"),
    ]);
    const diff = (session as any).computeObservationDiff(second);
    assert(diff && diff.full === false, JSON.stringify(diff));
    assert(diff.changed.length === 1 && diff.changed[0].id === 1, JSON.stringify(diff.changed));
    assert(diff.added.length === 1 && diff.added[0].id === 3, JSON.stringify(diff.added));
    assert(diff.removed.length === 1 && diff.removed[0] === 2, JSON.stringify(diff.removed));
    assert(diff.unchanged === 2 && diff.total === 4, JSON.stringify(diff));

    session.lastObservationDiff = diff;
    session.lastObservedState = second;
    assert(
      session.getObservationDiff(second)?.added[0]?.id === 3,
      "the latest observation exposes its diff",
    );
    assert(
      session.getObservationDiff(first) === undefined,
      "a stale observation must fall back to the full list",
    );
  });

  await testAsync("a wholesale DOM replacement is reported as a full observation", async () => {
    const session = freshSession();
    session.activeTargetId = "tab-full";
    const observed = (ids: number[]): ObservedState => ({
      url: "https://full.test/",
      title: "Full",
      text_sample: "",
      interactive_elements: ids.map((id) => ({
        id,
        tag: "a",
        text: `item ${id}`,
        x: 0,
        y: 0,
        w: 10,
        h: 10,
      })),
    });
    session.lastObservedState = observed([1, 2, 3]);
    session.lastObservedTargetId = "tab-full";
    const diff = (session as any).computeObservationDiff(observed([4, 5, 6, 7]));
    assert(diff?.full === true, JSON.stringify(diff));
  });

  await testAsync("summary extraction is free until the digest is returned", async () => {
    const { session } = readSession();
    const raw = await session.readForSummary({ maxChars: SUMMARY_INPUT_MAX_CHARS });
    assert(raw.success, JSON.stringify(raw));
    const normal = await session.readPage({ maxChars: READ_MAX_CHARS_PER_CALL });
    assert(normal.success, "raw summary text must not consume the read budget");
    session.noteSummaryOutput(READ_MAX_CHARS_PER_SESSION, null);
    const refused = await session.readPage({ maxChars: READ_MAX_CHARS_PER_CALL });
    assert(
      !refused.success && refused.reason === "read_budget",
      JSON.stringify(refused),
    );
  });

  console.log("attachment coalescing:");

  await testAsync("attaches and installs activity tracking once per tab", async () => {
    const calls: SendCall[] = [];
    const session = freshSession();
    session.client = fakeClient(async (call) => {
      calls.push(call);
      if (call.method === "Target.attachToTarget") {
        await Promise.resolve();
        return { sessionId: "session-new" };
      }
      return {};
    });

    const [first, second] = await Promise.all([
      session.ensureTargetSession("tab-new"),
      session.ensureTargetSession("tab-new"),
    ]);

    assert(first === "session-new" && second === first, "sessions must be shared");
    assert(
      calls.filter((call) => call.method === "Target.attachToTarget").length === 1,
      "concurrent discovery must attach only once",
    );
    assert(
      calls.filter((call) => call.method === "Runtime.addBinding").length === 1,
      "activity binding must be installed only once",
    );
    assert(
      calls.filter((call) => call.method === "Page.addScriptToEvaluateOnNewDocument")
        .length === 1,
      "new-document tracker must be installed only once",
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) throw new Error(`${failed} browser regression assertion(s) failed`);
}
bunTest('browserSession browser service regressions', async () => {
  await main()
})
