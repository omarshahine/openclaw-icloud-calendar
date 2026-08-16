import { Type } from "@sinclair/typebox";

const DateTimeDesc = "ISO 8601. Timed: 2026-08-16T09:00 (local, in the configured timezone) or 2026-08-16T16:00:00Z / with offset. All-day: YYYY-MM-DD.";

export const recurrenceSchema = Type.Object(
  {
    frequency: Type.Union([Type.Literal("DAILY"), Type.Literal("WEEKLY"), Type.Literal("MONTHLY"), Type.Literal("YEARLY")]),
    interval: Type.Optional(Type.Integer({ minimum: 1, description: "Every N periods (default 1)" })),
    count: Type.Optional(Type.Integer({ minimum: 1, description: "Total number of occurrences (mutually exclusive with until)" })),
    until: Type.Optional(Type.String({ description: "Last occurrence date/time (ISO 8601). Mutually exclusive with count." })),
    byDay: Type.Optional(Type.Array(Type.String(), { description: 'Weekdays: ["MO","WE","FR"]. For MONTHLY, ordinal form like "2TU" (second Tuesday) or "-1FR" (last Friday).' })),
    byMonthDay: Type.Optional(Type.Array(Type.Integer(), { description: "Days of month for MONTHLY, e.g. [1, 15] or [-1] for last day" })),
  },
  { additionalProperties: false },
);

export const listSchema = Type.Object({}, { additionalProperties: false });

export const eventsSchema = Type.Object(
  {
    from: Type.Optional(Type.String({ description: `Range start (inclusive). ${DateTimeDesc} Default: now.` })),
    to: Type.Optional(Type.String({ description: `Range end (exclusive). ${DateTimeDesc} Default: from + 7 days.` })),
    calendar: Type.Optional(Type.String({ description: "Calendar id or name. Omit to query all calendars." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Max events to return (default 200)" })),
  },
  { additionalProperties: false },
);

export const getSchema = Type.Object(
  {
    uid: Type.String({ description: "Event UID (from icloud_calendar_events)" }),
    calendar: Type.Optional(Type.String({ description: "Calendar id or name; speeds up lookup. Omit to search all calendars." })),
  },
  { additionalProperties: false },
);

const writableFields = {
  title: Type.Optional(Type.String({ description: "Event title" })),
  start: Type.Optional(Type.String({ description: `Start. ${DateTimeDesc}` })),
  end: Type.Optional(Type.String({ description: `End (timed: exclusive instant; all-day: inclusive last day). ${DateTimeDesc}` })),
  duration: Type.Optional(Type.Integer({ minimum: 1, description: "Duration in minutes; alternative to end" })),
  allDay: Type.Optional(Type.Boolean({ description: "Force all-day. Inferred from a YYYY-MM-DD start if omitted." })),
  location: Type.Optional(Type.String({ description: "Location text. Empty string clears it on update." })),
  notes: Type.Optional(Type.String({ description: "Notes/description. Empty string clears it on update." })),
  url: Type.Optional(Type.String({ description: "URL. Empty string clears it on update." })),
  alarms: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }), { description: "Reminders as minutes before start, e.g. [10, 60]. Empty array removes all alarms on update." })),
  recurrence: Type.Optional(recurrenceSchema),
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
    calendar: Type.Optional(Type.String({ description: "Calendar id or name the event lives in; speeds up lookup" })),
    ...writableFields,
    clearRecurrence: Type.Optional(Type.Boolean({ description: "Set true to remove recurrence (make the event one-off)" })),
  },
  { additionalProperties: false },
);

export const deleteSchema = Type.Object(
  {
    uid: Type.String({ description: "UID of the event to delete (deletes the whole series for recurring events)" }),
    calendar: Type.Optional(Type.String({ description: "Calendar id or name the event lives in; speeds up lookup" })),
  },
  { additionalProperties: false },
);
