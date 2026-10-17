-- PIN brute-force protection
ALTER TABLE students ADD COLUMN pin_fails INTEGER NOT NULL DEFAULT 0;
ALTER TABLE students ADD COLUMN locked_until TEXT;
