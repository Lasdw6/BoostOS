-- Delete workflows that have no steps
DELETE FROM workflows 
WHERE id NOT IN (
  SELECT DISTINCT workflow_id FROM workflow_steps
);
