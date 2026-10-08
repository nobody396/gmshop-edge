ALTER TABLE agent_access_orders ADD policy_snapshot TEXT CHECK(policy_snapshot IS NULL OR json_valid(policy_snapshot));
