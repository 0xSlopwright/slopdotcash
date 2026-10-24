-- PRD section 8: after a confirmed malicious result, a moderator decides
-- whether to reinstate the project or ban it and the maintainer. A maintainer
-- ban is part of one moderator's ban or denied-appeal record of that project.
-- It names the project steward and the account that listed the project by
-- immutable GitHub actor id. While the project stays banned, those accounts
-- cannot create, publish or change a project. A later independent
-- reinstatement of the project ends the maintainer ban; history stays.
CREATE TABLE project_maintainer_bans (
  enforcement_id TEXT NOT NULL REFERENCES project_enforcements(id),
  github_id TEXT NOT NULL CHECK (github_id GLOB '[1-9]*' AND github_id NOT GLOB '*[^0-9]*'),
  github_login TEXT NOT NULL CHECK (length(github_login) BETWEEN 1 AND 39),
  PRIMARY KEY (enforcement_id, github_id)
) STRICT;

CREATE TRIGGER project_maintainer_bans_valid
BEFORE INSERT ON project_maintainer_bans
WHEN NOT EXISTS (
  SELECT 1 FROM project_enforcements e
  WHERE e.id = NEW.enforcement_id
    AND e.action IN ('ban', 'deny_reinstatement')
    AND e.state_after = 'banned'
    AND e.actor_role = 'project-moderator'
)
BEGIN
  SELECT RAISE(ABORT, 'a maintainer ban needs a moderator ban of the project');
END;

CREATE TRIGGER project_maintainer_bans_no_update
BEFORE UPDATE ON project_maintainer_bans
BEGIN
  SELECT RAISE(ABORT, 'maintainer bans are immutable');
END;

CREATE TRIGGER project_maintainer_bans_no_delete
BEFORE DELETE ON project_maintainer_bans
BEGIN
  SELECT RAISE(ABORT, 'maintainer bans are permanent');
END;
