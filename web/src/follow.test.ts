import { expect, it, vi } from "vitest";
import {
  FollowController,
  validateFollowView,
  type FollowView,
} from "./follow";

const view: FollowView = {
  protocol_version: 1,
  notebook_path: "a.ipynb",
  scroll_fraction: 0.75,
  driver_id: "driver",
  selected_cell_id: "cell-2",
};
it("rejects unsafe paths, versions and unbounded positions", () => {
  expect(validateFollowView(view)).toEqual(view);
  for (const change of [
    { protocol_version: 2 },
    { notebook_path: "../a.ipynb" },
    { notebook_path: "/a.ipynb" },
    { scroll_fraction: NaN },
    { scroll_fraction: 1.1 },
    { selected_cell_id: "" },
    { selected_cell_id: "x".repeat(129) },
    { selected_cell_id: 3 },
    { microscope: { cell_id: "cell", microscope_id: "../oops" } },
    { microscope: { cell_id: "", microscope_id: "abc1234" } },
    { microscope: { cell_id: "x".repeat(129), microscope_id: "abc1234" } },
  ])
    expect(() => validateFollowView({ ...view, ...change })).toThrow();
});
it("accepts a bounded microscope target and explicit notebook mode", () => {
  for (const microscope of [
    null,
    { cell_id: "cell-2", microscope_id: "abc1234" },
  ])
    expect(validateFollowView({ ...view, microscope }).microscope).toEqual(
      microscope,
    );
});
it("requires opt in, cancels pending navigation on opt out and ignores late transport events", async () => {
  let receive: (view: FollowView | null) => void = () => {};
  let guard = () => true;
  let finish = () => {};
  const apply = vi.fn(async (_view: FollowView, current: () => boolean) => {
    guard = current;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const cancel = vi.fn();
  const clear = vi.fn();
  const follow = new FollowController(apply, clear, vi.fn());
  expect(follow.enabled).toBe(false);
  follow.start({
    subscribe(callback) {
      receive = callback;
      return cancel;
    },
  });
  receive(view);
  expect(apply).toHaveBeenCalledOnce();
  expect(guard()).toBe(true);
  follow.stop();
  expect(guard()).toBe(false);
  expect(cancel).toHaveBeenCalledOnce();
  receive(view);
  finish();
  await Promise.resolve();
  expect(apply).toHaveBeenCalledOnce();
  expect(clear).toHaveBeenCalled();
});
it("driver departure invalidates in-flight follow and clears pinned scrolling", async () => {
  let receive: (view: FollowView | null) => void = () => {};
  let guard = () => true;
  const clear = vi.fn();
  const paused = vi.fn();
  const follow = new FollowController(
    async (_view, current) => {
      guard = current;
    },
    clear,
    paused,
  );
  follow.start({
    subscribe(callback) {
      receive = callback;
      return () => {};
    },
  });
  receive(view);
  receive(null);
  expect(guard()).toBe(false);
  expect(paused).toHaveBeenCalledOnce();
  expect(clear).toHaveBeenCalledTimes(2);
  follow.stop();
});
