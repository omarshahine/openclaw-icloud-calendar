import { Type, type TSchema } from "@sinclair/typebox";

/** Optional and nullable: models frequently send null for fields they do not use. */
const OptNull = <T extends TSchema>(schema: T) => Type.Optional(Type.Union([schema, Type.Null()]));

const DateTimeDesc = "ISO 8601. Timed: 2026-08-16T09:00 (local, in the configured timezone) or 2026-08-16T16:00:00Z / with offset. All-day: YYYY-MM-DD.";

export const recurrenceSchema = Type.Object(
  {
    frequency: Type.Union([Type.Literal("DAILY"), Type.Literal("WEEKLY"), Type.Literal("MONTHLY"), Type.Literal("YEARLY")]),
    interval: OptNull(Type.Integer({ minimum: 1, description: "Every N periods (default 1)" })),
    count: OptNull(Type.Integer({ minimum: 1, description: "Total number of occurrences (mutually exclusive with until)" })),
    until: OptNull(Type.String({ description: "Last occurrence date/time (ISO 8601). Mutually exclusive with count." })),
    byDay: OptNull(Type.Array(Type.String(), { description: 'Weekdays: ["MO","WE","FR"]. For MONTHLY, ordinal form like "2TU" (second Tuesday) or "-1FR" (last Friday).' })),
    byMonthDay: OptNull(Type.Array(Type.Integer(), { description: "Days of month for MONTHLY, e.g. [1, 15] or [-1] for last day" })),
  },
  { additionalProperties: false },
);

export const listSchema = Type.Object({}, { additionalProperties: false });

export const eventsSchema = Type.Object(
  {
    from: OptNull(Type.String({ description: `Range start (inclusive). ${DateTimeDesc} Default: now.` })),
    to: OptNull(Type.String({ description: `Range end (exclusive). ${DateTimeDesc} Default: from + 7 days.` })),
    calendar: OptNull(Type.String({ description: "Calendar id or name. Omit to query all calendars." })),
    limit: OptNull(Type.Integer({ minimum: 1, maximum: 1000, description: "Max events to return (default 200)" })),
  },
  { additionalProperties: false },
);

export const getSchema = Type.Object(
  {
    uid: Type.String({ description: "Event UID (from icloud_calendar_events)" }),
    calendar: OptNull(Type.String({ description: "Calendar id or name; speeds up lookup. Omit to search all calendars." })),
  },
  { additionalProperties: false },
);

const writableFields = {
  title: OptNull(Type.String({ description: "Event title" })),
  start: OptNull(Type.String({ description: `Start. ${DateTimeDesc}` })),
  end: OptNull(Type.String({ description: `End (timed: exclusive instant; all-day: inclusive last day). ${DateTimeDesc}` })),
  duration: OptNull(Type.Integer({ minimum: 1, description: "Duration in minutes; alternative to end" })),
  allDay: OptNull(Type.Boolean({ description: "Force all-day. Inferred from a YYYY-MM-DD start if omitted." })),
  location: OptNull(Type.String({ description: "Location text. Empty string or null clears it on update." })),
  notes: OptNull(Type.String({ description: "Notes/description. Empty string or null clears it on update." })),
  url: OptNull(Type.String({ description: "URL. Empty string or null clears it on update." })),
  alarms: OptNull(Type.Array(Type.Integer({ minimum: 0 }), { description: "Reminders as minutes before start, e.g. [10, 60]. Empty array or null removes all alarms on update." })),
  recurrence: OptNull(recurrenceSchema),
};

export const createSchema = Type.Object(
  {
    ...writableFields,
    title: Type.String({ description: "Event title" }),
    start: Type.String({ description: `Start. ${DateTimeDesc}` }),
    calendar: Type.String({ description: "Target calendar id or name (required; use icloud_calendar_list)" }),
  },
  { additionalProperties: false },
);

export const updateSchema = Type.Object(
  {
    uid: Type.String({ description: "UID of the event to update" }),
    calendar: OptNull(Type.String({ description: "Calendar id or name the event lives in; speeds up lookup" })),
    ...writableFields,
    clearRecurrence: OptNull(Type.Boolean({ description: "Set true to remove recurrence (make the event one-off)" })),
  },
  { additionalProperties: false },
);

export const deleteSchema = Type.Object(
  {
    uid: Type.String({ description: "UID of the event to delete (deletes the whole series for recurring events)" }),
    calendar: OptNull(Type.String({ description: "Calendar id or name the event lives in; speeds up lookup" })),
  },
  { additionalProperties: false },
);
