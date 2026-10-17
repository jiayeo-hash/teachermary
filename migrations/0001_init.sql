-- Teacher Mary: classes, students, lessons, files, homework

CREATE TABLE classes (
  id          TEXT PRIMARY KEY,            -- random id
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A class keeps one roster. Changes made while creating a lesson carry
-- forward to later lessons. left_on keeps old lessons correct.
CREATE TABLE students (
  id          TEXT PRIMARY KEY,
  class_id    TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,               -- first name + initial, e.g. "Linh T."
  color       TEXT,
  pin_hash    TEXT,                        -- optional 4-digit PIN, hashed
  added_on    TEXT NOT NULL DEFAULT (date('now')),
  left_on     TEXT                         -- NULL while still in the class
);
CREATE INDEX students_class ON students(class_id);

CREATE TABLE lessons (
  id          TEXT PRIMARY KEY,
  class_id    TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,        -- long random string in the student link
  lesson_date TEXT NOT NULL,               -- YYYY-MM-DD
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('draft','open','closed')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX lessons_class_date ON lessons(class_id, lesson_date);

-- Reading and worksheets Mary uploads for a lesson
CREATE TABLE materials (
  id            TEXT PRIMARY KEY,
  lesson_id     TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  r2_key        TEXT NOT NULL,
  size_bytes    INTEGER,
  content_type  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Homework: one per student per lesson. Replacing keeps the same row.
CREATE TABLE submissions (
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
  feedback      TEXT,
  UNIQUE (lesson_id, student_id)
);

-- Login sessions for students (after tapping their name / PIN)
CREATE TABLE student_sessions (
  token_hash  TEXT PRIMARY KEY,
  student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  lesson_id   TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL
);
