-- Independent one-use Security grant for the initial machine enrollment command.
ALTER TABLE ephor_machine ADD COLUMN security_enrollment_hash TEXT;
