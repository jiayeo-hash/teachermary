-- One permanent link per class, weekly schedule, several homework files per lesson.

ALTER TABLE classes ADD COLUMN token TEXT;
UPDATE classes SET token = lower(hex(randomblob(24)));
CREATE UNIQUE INDEX classes_token ON classes(token);
ALTER TABLE classes ADD COLUMN schedule TEXT NOT NULL DEFAULT '[]';   -- [{"dow":2,"time":"19:00"}, ...] dow: 0=Sun
ALTER TABLE classes ADD COLUMN generated_until TEXT;                  -- lessons exist up to this date
ALTER TABLE classes ADD COLUMN multi INTEGER NOT NULL DEFAULT 0;      -- 1 = students may hand in several files
ALTER TABLE classes ADD COLUMN auto_close_days INTEGER;               -- NULL = lessons stay open until closed by hand

ALTER TABLE lessons ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;       -- 1 = made by the schedule

-- Homework: several rows per student per lesson are allowed now.
CREATE TABLE submissions_new (
  id            TEXT PRIMARY KEY,
  lesson_id     TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  student_id    TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  r2_key        TEXT NOT NULL,
  size_bytes    INTEGER,
  content_type  TEXT,
  uploaded_at   TEXT NOT NULL DEFAULT (datetime('now')),
  replaced_at   TEXT,
  reviewed      INTEGER NOT NULL DEFAULT 0,
  feedback      TEXT
);
INSERT INTO submissions_new SELECT id, lesson_id, student_id, name, r2_key, size_bytes, content_type, uploaded_at, replaced_at, reviewed, feedback FROM submissions;
DROP TABLE submissions;
ALTER TABLE submissions_new RENAME TO submissions;
CREATE INDEX submissions_lesson_student ON submissions(lesson_id, student_id);

-- Sessions now belong to the class link, not to one lesson.
DROP TABLE student_sessions;
CREATE TABLE student_sessions (
  token_hash  TEXT PRIMARY KEY,
  student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  class_id    TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL
);
