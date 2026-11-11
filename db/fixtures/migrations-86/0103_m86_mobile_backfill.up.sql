-- phase: migrate
-- batch: true
-- Step 2 (migrate): copy old rows in batches of 500, one short transaction each.
UPDATE m86_students SET mobile = phone
 WHERE id IN (SELECT id FROM m86_students WHERE mobile IS NULL AND phone IS NOT NULL ORDER BY id LIMIT 500);
