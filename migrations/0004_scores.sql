-- Per-lesson scores Mary gives each student, shown to parents once she shares them.

CREATE TABLE lesson_scores (
  lesson_id      TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  student_id     TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  participation  INTEGER,            -- 1 to 5, NULL = not scored
  behavior       INTEGER,
  homework       INTEGER,            -- 1 = yes, 0 = no, NULL = not recorded
  activity       INTEGER,
  understanding  INTEGER,
  comment        TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (lesson_id, student_id)
);

ALTER TABLE lessons ADD COLUMN scores_shared INTEGER NOT NULL DEFAULT 0;  -- 1 = parents can see this lesson's scores
