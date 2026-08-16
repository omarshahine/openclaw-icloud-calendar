/**
 * Live integration test against a real iCloud account. Opt-in:
 *
 *   ICLOUD_INTEGRATION=1 ICLOUD_TEST_APPLE_ID=you@icloud.com \
 *   ICLOUD_TEST_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx ICLOUD_TEST_CALENDAR="Home" \
 *   npm run test:integration
 *
 * Creates, reads, updates and deletes one "[openclaw-test]" event in the
 * named calendar. Nothing else is touched.
 */
import { afterAll, describe, expect, it } from "vitest";
import { CalDavClient } from "../../src/caldav/client.js";
import { Session } from "../../src/caldav/discovery.js";
import { handleCreate, handleDelete, handleEvents, handleGet, handleList, handleUpdate, type Context } from "../../src/tools/handlers.js";

const enabled = process.env.ICLOUD_INTEGRATION === "1" && !!process.env.ICLOUD_TEST_APPLE_ID && !!process.env.ICLOUD_TEST_APP_PASSWORD;

describe.skipIf(!enabled)("live iCloud", () => {
  const tz = process.env.ICLOUD_TEST_TZ || "America/Los_Angeles";
  const client = new CalDavClient({ serverUrl: "https://caldav.icloud.com", username: process.env.ICLOUD_TEST_APPLE_ID!, password: process.env.ICLOUD_TEST_APP_PASSWORD! });
  const ctx: Context = { session: new Session(client), config: { appleId: "", appPassword: "", timezone: tz, serverUrl: "https://caldav.icloud.com", calendars: [], readOnly: false } };
  const calendar = process.env.ICLOUD_TEST_CALENDAR || "Home";
  let uid: string | undefined;

  afterAll(async () => {
    if (uid) await handleDelete(ctx, { uid }).catch(() => undefined);
  });

  it("discovers calendars", async () => {
    const res = await handleList(ctx);
    expect(res.calendars.length).toBeGreaterThan(0);
    expect(res.calendars.map((c) => c.name)).toContain(calendar);
  });

  it("lists upcoming events without error", async () => {
    const res = await handleEvents(ctx, {});
    expect(Array.isArray(res.events)).toBe(true);
  });

  it("creates, gets, updates and deletes an event", async () => {
    const start = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10) + "T15:00";
    const created = await handleCreate(ctx, { title: "[openclaw-test] integration", start, duration: 30, calendar, notes: "safe to delete", alarms: [10] });
    uid = created.event.uid;
    expect(created.verification.allFieldsMatch).toBe(true);
    const got = await handleGet(ctx, { uid, calendar });
    expect(got.title).toBe("[openclaw-test] integration");
    expect(got.alarms).toEqual([10]);
    const upd = await handleUpdate(ctx, { uid, calendar, title: "[openclaw-test] updated", location: "Nowhere" });
    expect(upd.event.title).toBe("[openclaw-test] updated");
    expect(upd.event.location).toBe("Nowhere");
    const del = await handleDelete(ctx, { uid, calendar });
    expect(del.deleted).toBe(true);
    uid = undefined;
  });
});
