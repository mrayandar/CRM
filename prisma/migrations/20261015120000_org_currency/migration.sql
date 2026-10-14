-- Additive: org-level currency setting. Defaults every existing org to "USD" so nothing changes
-- for anyone until they explicitly pick a different currency from Settings -> Workspace.
ALTER TABLE "organizations" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD';
