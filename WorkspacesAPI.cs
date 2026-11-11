using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.WebAPI;

namespace Hartsy.Extensions;

/// <summary>API routes for the user's saved workspaces and their drafts (unsaved changes). Everything the Generate tab toolbar does goes through these routes, so any client can do the same.</summary>
[API.APIClass("Routes for managing the user's saved workspaces: whole Generate-tab setups that can be saved, resolved into parameters, and restored.")]
public static class WorkspacesAPI
{
    /// <summary>Permission to list, save, resolve, and delete the user's own workspaces and drafts.</summary>
    public static PermInfo PermManageWorkspaces = Permissions.Register(new("workspaces_manage_workspaces", "[Workspaces] Manage Workspaces", "Allows this user to list, save, and delete their own workspaces.", PermissionDefault.USER, Permissions.GroupUser));

    /// <summary>Lists the user's workspaces.</summary>
    [API.APIDescription("Lists the user's workspaces, by default without their snapshots.", "\"workspaces\": [ { \"id\": \"abc123\", \"name\": \"Portrait photo\", \"revision\": 3, \"starred\": false, \"created_at\": \"2026-01-01T00:00:00.0000000Z\", \"updated_at\": \"2026-01-02T00:00:00.0000000Z\" } ]")]
    public static Task<JObject> WorkspacesList(Session session,
        [API.APIParameter("If true, include each workspace's full snapshot too.")] bool snapshots = false)
    {
        lock (WorkspaceStore.GetLock(session.User))
        {
            JArray list = new();
            foreach (JToken entry in WorkspaceStore.Load(session.User))
            {
                list.Add(WorkspaceStore.NetData((JObject)entry, snapshots));
            }
            return Task.FromResult(new JObject() { ["workspaces"] = list });
        }
    }

    /// <summary>Returns one workspace with its snapshot.</summary>
    [API.APIDescription("Returns one workspace, including its snapshot.", "\"workspace\": { \"id\": \"abc123\", \"name\": \"Portrait photo\", \"revision\": 3, \"starred\": false, \"snapshot\": { \"schemaVersion\": 1, \"values\": { }, \"groups\": { }, \"presets\": [ ], \"unsupported\": [ ] } }")]
    public static Task<JObject> WorkspacesGet(Session session,
        [API.APIParameter("The workspace ID.")] string id)
    {
        lock (WorkspaceStore.GetLock(session.User))
        {
            JArray list = WorkspaceStore.Load(session.User);
            if (!WorkspaceStore.Find(list, id, out int index, out JObject findError))
            {
                return Task.FromResult(findError);
            }
            return Task.FromResult(new JObject() { ["workspace"] = WorkspaceStore.NetData((JObject)list[index], true) });
        }
    }

    /// <summary>Creates a workspace from a snapshot. The server assigns the ID, revision 1, and timestamps.</summary>
    [API.APIDescription("Creates a workspace. Send 'name' (string) and 'snapshot' (object: schemaVersion 1, values, groups, presets as a list of { title }, unsupported), and optionally 'starred' (bool). The presets must exist; the server records their current definition. Returns the stored workspace.", "\"success\": true, \"workspace\": { \"id\": \"abc123\", \"name\": \"Portrait photo\", \"revision\": 1 }")]
    public static Task<JObject> WorkspacesCreate(Session session,
        [API.APIParameter("Raw body: 'name' (string), 'snapshot' (object), and optional 'starred' (bool).")] JObject raw)
    {
        if (!WorkspaceStore.ValidateName(raw["name"]?.ToString(), out string name, out JObject nameError))
        {
            return Task.FromResult(nameError);
        }
        if (!WorkspaceStore.ValidateSnapshot(raw["snapshot"], out JObject snapError))
        {
            return Task.FromResult(snapError);
        }
        if (!WorkspaceStore.ValidateStarred(raw["starred"], out bool starred, out JObject starError))
        {
            return Task.FromResult(starError);
        }
        JObject snapshot = (JObject)raw["snapshot"];
        if (!WorkspaceStore.StampPresets(session.User, snapshot, out JObject presetError))
        {
            return Task.FromResult(presetError);
        }
        lock (WorkspaceStore.GetLock(session.User))
        {
            JArray list = WorkspaceStore.Load(session.User);
            if (list.Count >= WorkspaceStore.MaxWorkspaces)
            {
                return Task.FromResult(WorkspaceStore.Error("quota_exceeded", $"You can store at most {WorkspaceStore.MaxWorkspaces} workspaces."));
            }
            string now = DateTime.UtcNow.ToString("o");
            JObject entry = WorkspaceStore.BuildEntry(snapshot, Guid.NewGuid().ToString("N"), name, 1, now, now, starred);
            list.Add(entry);
            if (!WorkspaceStore.TrySave(session.User, list, out JObject saveError))
            {
                return Task.FromResult(saveError);
            }
            return Task.FromResult(new JObject() { ["success"] = true, ["workspace"] = WorkspaceStore.NetData(entry, false) });
        }
    }

    /// <summary>Replaces a workspace's snapshot (and optionally its name). The revision must match the stored one.</summary>
    [API.APIDescription("Updates a workspace's snapshot, and its name if one is sent. Send 'id', 'revision' (the revision you last saw), 'snapshot', and optionally 'name'. Its star is kept. Returns the workspace with its new revision.", "\"success\": true, \"workspace\": { \"id\": \"abc123\", \"name\": \"Portrait photo\", \"revision\": 4 }")]
    public static Task<JObject> WorkspacesUpdate(Session session,
        [API.APIParameter("Raw body: 'id' (string), 'revision' (int), 'snapshot' (object), and optional 'name' (string).")] JObject raw)
    {
        string id = raw["id"]?.ToString() ?? "";
        if (!ReadInt(raw["revision"], out int revision))
        {
            return Task.FromResult(WorkspaceStore.Error("invalid_revision", "'revision' must be an integer."));
        }
        string newName = null;
        if (raw["name"] != null && !WorkspaceStore.ValidateName(raw["name"].ToString(), out newName, out JObject nameError))
        {
            return Task.FromResult(nameError);
        }
        if (!WorkspaceStore.ValidateSnapshot(raw["snapshot"], out JObject snapError))
        {
            return Task.FromResult(snapError);
        }
        JObject snapshot = (JObject)raw["snapshot"];
        if (!WorkspaceStore.StampPresets(session.User, snapshot, out JObject presetError))
        {
            return Task.FromResult(presetError);
        }
        lock (WorkspaceStore.GetLock(session.User))
        {
            JArray list = WorkspaceStore.Load(session.User);
            if (!WorkspaceStore.FindChecked(list, id, revision, out int index, out JObject findError))
            {
                return Task.FromResult(findError);
            }
            JObject current = (JObject)list[index];
            bool starred = current["bookmarked"]?.Type == JTokenType.Boolean && current["bookmarked"].Value<bool>();
            JObject entry = WorkspaceStore.BuildEntry(snapshot, id, newName ?? current["name"].ToString(), revision + 1, current["createdAt"]?.ToString() ?? DateTime.UtcNow.ToString("o"), DateTime.UtcNow.ToString("o"), starred);
            list[index] = entry;
            if (!WorkspaceStore.TrySave(session.User, list, out JObject saveError))
            {
                return Task.FromResult(saveError);
            }
            return Task.FromResult(new JObject() { ["success"] = true, ["workspace"] = WorkspaceStore.NetData(entry, false) });
        }
    }

    /// <summary>Renames a workspace without changing its snapshot. The revision must match.</summary>
    [API.APIDescription("Renames a workspace. Returns the new revision.", "\"success\": true, \"revision\": 2")]
    public static Task<JObject> WorkspacesRename(Session session,
        [API.APIParameter("The workspace ID.")] string id,
        [API.APIParameter("The revision you last saw.")] int revision,
        [API.APIParameter("The new name.")] string name)
    {
        if (!WorkspaceStore.ValidateName(name, out string trimmed, out JObject nameError))
        {
            return Task.FromResult(nameError);
        }
        return Task.FromResult(ChangeEntry(session, id, revision, current => current["name"] = trimmed));
    }

    /// <summary>Stars or unstars a workspace without touching its snapshot. The revision must match.</summary>
    [API.APIDescription("Stars or unstars a workspace. Returns the new revision.", "\"success\": true, \"revision\": 2")]
    public static Task<JObject> WorkspacesStar(Session session,
        [API.APIParameter("The workspace ID.")] string id,
        [API.APIParameter("The revision you last saw.")] int revision,
        [API.APIParameter("True to star it, false to unstar it.")] bool starred)
    {
        return Task.FromResult(ChangeEntry(session, id, revision, current => current["bookmarked"] = starred));
    }

    /// <summary>Deletes a workspace, and its draft. The revision must match.</summary>
    [API.APIDescription("Deletes a workspace and its draft.", "\"success\": true")]
    public static Task<JObject> WorkspacesDelete(Session session,
        [API.APIParameter("The workspace ID.")] string id,
        [API.APIParameter("The revision you last saw.")] int revision)
    {
        lock (WorkspaceStore.GetLock(session.User))
        {
            JArray list = WorkspaceStore.Load(session.User);
            if (!WorkspaceStore.FindChecked(list, id, revision, out int index, out JObject findError))
            {
                return Task.FromResult(findError);
            }
            list.RemoveAt(index);
            if (!WorkspaceStore.TrySave(session.User, list, out JObject saveError))
            {
                return Task.FromResult(saveError);
            }
            // A draft of a deleted workspace has nothing to restore into. Best effort: a leftover is dropped the next time drafts are listed.
            JObject drafts = WorkspaceStore.LoadDrafts(session.User);
            if (drafts.Remove(id))
            {
                WorkspaceStore.TrySaveDrafts(session.User, drafts, out JObject _);
            }
            return Task.FromResult(new JObject() { ["success"] = true });
        }
    }

    /// <summary>Resolves a workspace (or its draft) into what a client needs to use it.</summary>
    [API.APIDescription("Resolves a workspace, or its draft, against this server's real parameter definitions using SwarmUI's own validation. Returns 'values' and 'groups' to apply to a Generate tab (only for the chosen parts), 'enable_groups' (parent toggle groups a partial load must switch on), 'presets' with a status each ('ok', 'changed', 'missing', or 'unverified'; null if the presets were not chosen), 'params' (generation-ready: enabled values only, checked and normalized, ready to send to GenerateText2Image with 'presets'), 'skipped' (anything that could not be used, and why), 'unsupported' (state the workspace could not capture), and 'parts' (what the workspace contains, to offer a choice).", "\"workspace\": { \"id\": \"abc123\", \"name\": \"Portrait photo\", \"revision\": 3 }, \"values\": { \"steps\": { \"value\": 30, \"enabled\": true } }, \"groups\": { }, \"enable_groups\": [ ], \"presets\": [ { \"title\": \"Sharp\", \"status\": \"ok\" } ], \"params\": { \"steps\": \"30\" }, \"skipped\": [ ], \"unsupported\": [ ], \"parts\": { \"model\": true, \"presets\": true, \"other\": true, \"groups\": [ { \"id\": \"coreparameters\", \"name\": \"Core Parameters\", \"parent\": null, \"depth\": 0 } ] }")]
    public static Task<JObject> WorkspacesResolve(Session session,
        [API.APIParameter("The workspace ID.")] string id,
        [API.APIParameter("Which parts to take, as { model: bool, presets: bool, other: bool, groups: [group IDs] }. Leave out (or send {}) to take everything.")] JObject parts = null,
        [API.APIParameter("If true, resolve the workspace's draft (its unsaved changes) instead of its saved snapshot.")] bool draft = false)
    {
        if (!WorkspaceResolver.TryParseParts(parts, out WorkspaceResolver.Selection selection, out JObject partsError))
        {
            return Task.FromResult(partsError);
        }
        JObject entry;
        JObject snapshot;
        lock (WorkspaceStore.GetLock(session.User))
        {
            JArray list = WorkspaceStore.Load(session.User);
            if (!WorkspaceStore.Find(list, id, out int index, out JObject findError))
            {
                return Task.FromResult(findError);
            }
            entry = (JObject)list[index].DeepClone();
            snapshot = entry;
            if (draft)
            {
                JObject saved = WorkspaceStore.LoadDrafts(session.User)[id] as JObject;
                if (saved is null)
                {
                    return Task.FromResult(WorkspaceStore.Error("no_draft", "This workspace has no draft."));
                }
                snapshot = (JObject)saved["snapshot"];
            }
        }
        return Task.FromResult(WorkspaceResolver.Resolve(session, entry, snapshot, selection));
    }

    /// <summary>Saves a workspace's draft: the unsaved changes of someone working on it. One draft is kept per workspace, and the newest save wins.</summary>
    [API.APIDescription("Saves the draft (unsaved changes) of a workspace, replacing any earlier draft of it. Send 'id', 'revision' (the workspace revision being edited), and 'snapshot'. Drafts are kept for 14 days, one per workspace, and are removed when the workspace is deleted.", "\"success\": true, \"saved_at\": \"2026-01-02T00:00:00.0000000Z\"")]
    public static Task<JObject> WorkspacesDraftSave(Session session,
        [API.APIParameter("Raw body: 'id' (string), 'revision' (int), and 'snapshot' (object).")] JObject raw)
    {
        string id = raw["id"]?.ToString() ?? "";
        if (!ReadInt(raw["revision"], out int revision))
        {
            return Task.FromResult(WorkspaceStore.Error("invalid_revision", "'revision' must be an integer."));
        }
        if (!WorkspaceStore.ValidateSnapshot(raw["snapshot"], out JObject snapError))
        {
            return Task.FromResult(snapError);
        }
        JObject snapshot = WorkspaceStore.CopySnapshotFields((JObject)raw["snapshot"]);
        // A draft keeps preset titles only. Whether a preset still exists is checked when the draft is resolved.
        JArray titles = new();
        foreach (JToken preset in (JArray)snapshot["presets"])
        {
            titles.Add(new JObject() { ["title"] = preset["title"] });
        }
        snapshot["presets"] = titles;
        lock (WorkspaceStore.GetLock(session.User))
        {
            if (!WorkspaceStore.Find(WorkspaceStore.Load(session.User), id, out int _, out JObject findError))
            {
                return Task.FromResult(findError);
            }
            JObject drafts = WorkspaceStore.LoadDrafts(session.User);
            if (!drafts.ContainsKey(id) && drafts.Count >= WorkspaceStore.MaxDrafts)
            {
                return Task.FromResult(WorkspaceStore.Error("quota_exceeded", $"You can keep drafts for at most {WorkspaceStore.MaxDrafts} workspaces."));
            }
            string now = DateTime.UtcNow.ToString("o");
            drafts[id] = new JObject() { ["id"] = id, ["revision"] = revision, ["savedAt"] = now, ["snapshot"] = snapshot };
            if (!WorkspaceStore.TrySaveDrafts(session.User, drafts, out JObject saveError))
            {
                return Task.FromResult(saveError);
            }
            return Task.FromResult(new JObject() { ["success"] = true, ["saved_at"] = now });
        }
    }

    /// <summary>Lists the user's drafts, newest first, without their snapshots.</summary>
    [API.APIDescription("Lists the drafts (unsaved changes) the user has, newest first, without their snapshots. A draft whose workspace no longer exists is dropped.", "\"drafts\": [ { \"id\": \"abc123\", \"name\": \"Portrait photo\", \"revision\": 3, \"workspace_revision\": 4, \"saved_at\": \"2026-01-02T00:00:00.0000000Z\" } ]")]
    public static Task<JObject> WorkspacesDraftList(Session session)
    {
        lock (WorkspaceStore.GetLock(session.User))
        {
            JArray list = WorkspaceStore.Load(session.User);
            JObject drafts = WorkspaceStore.LoadDrafts(session.User);
            List<JObject> found = [];
            bool dropped = false;
            foreach (KeyValuePair<string, JToken> pair in drafts.Properties().Select(p => new KeyValuePair<string, JToken>(p.Name, p.Value)).ToList())
            {
                if (!WorkspaceStore.Find(list, pair.Key, out int index, out JObject _))
                {
                    drafts.Remove(pair.Key);
                    dropped = true;
                    continue;
                }
                found.Add(new JObject()
                {
                    ["id"] = pair.Key,
                    ["name"] = list[index]["name"],
                    ["revision"] = pair.Value["revision"],
                    ["workspace_revision"] = list[index]["revision"],
                    ["saved_at"] = pair.Value["savedAt"]
                });
            }
            if (dropped)
            {
                WorkspaceStore.TrySaveDrafts(session.User, drafts, out JObject _);
            }
            found.Sort((a, b) => string.CompareOrdinal(b["saved_at"].ToString(), a["saved_at"].ToString()));
            return Task.FromResult(new JObject() { ["drafts"] = new JArray(found) });
        }
    }

    /// <summary>Returns one draft with its snapshot.</summary>
    [API.APIDescription("Returns the draft of a workspace, including its snapshot.", "\"draft\": { \"id\": \"abc123\", \"name\": \"Portrait photo\", \"revision\": 3, \"workspace_revision\": 4, \"saved_at\": \"2026-01-02T00:00:00.0000000Z\", \"snapshot\": { } }")]
    public static Task<JObject> WorkspacesDraftGet(Session session,
        [API.APIParameter("The workspace ID.")] string id)
    {
        lock (WorkspaceStore.GetLock(session.User))
        {
            JArray list = WorkspaceStore.Load(session.User);
            if (!WorkspaceStore.Find(list, id, out int index, out JObject findError))
            {
                return Task.FromResult(findError);
            }
            JObject saved = WorkspaceStore.LoadDrafts(session.User)[id] as JObject;
            if (saved is null)
            {
                return Task.FromResult(WorkspaceStore.Error("no_draft", "This workspace has no draft."));
            }
            return Task.FromResult(new JObject()
            {
                ["draft"] = new JObject()
                {
                    ["id"] = id,
                    ["name"] = list[index]["name"],
                    ["revision"] = saved["revision"],
                    ["workspace_revision"] = list[index]["revision"],
                    ["saved_at"] = saved["savedAt"],
                    ["snapshot"] = saved["snapshot"].DeepClone()
                }
            });
        }
    }

    /// <summary>Deletes a workspace's draft. Succeeds even if there is none.</summary>
    [API.APIDescription("Deletes the draft of a workspace. Succeeds even if it has none.", "\"success\": true")]
    public static Task<JObject> WorkspacesDraftDelete(Session session,
        [API.APIParameter("The workspace ID.")] string id)
    {
        lock (WorkspaceStore.GetLock(session.User))
        {
            JObject drafts = WorkspaceStore.LoadDrafts(session.User);
            if (drafts.Remove(id) && !WorkspaceStore.TrySaveDrafts(session.User, drafts, out JObject saveError))
            {
                return Task.FromResult(saveError);
            }
            return Task.FromResult(new JObject() { ["success"] = true });
        }
    }

    /// <summary>Changes one stored field of a workspace without touching its snapshot, checking the revision, and bumps the revision.</summary>
    /// <param name="session">The user's session.</param>
    /// <param name="id">The workspace ID.</param>
    /// <param name="revision">The revision the client last saw.</param>
    /// <param name="change">The change to make to the stored entry.</param>
    /// <returns>The success response with the new revision, or an error.</returns>
    public static JObject ChangeEntry(Session session, string id, int revision, Action<JObject> change)
    {
        lock (WorkspaceStore.GetLock(session.User))
        {
            JArray list = WorkspaceStore.Load(session.User);
            if (!WorkspaceStore.FindChecked(list, id, revision, out int index, out JObject findError))
            {
                return findError;
            }
            JObject current = (JObject)list[index];
            change(current);
            current["revision"] = revision + 1;
            current["updatedAt"] = DateTime.UtcNow.ToString("o");
            if (!WorkspaceStore.TrySave(session.User, list, out JObject saveError))
            {
                return saveError;
            }
            return new JObject() { ["success"] = true, ["revision"] = revision + 1 };
        }
    }

    /// <summary>Reads an integer field from a raw JSON token.</summary>
    /// <param name="token">The token to read.</param>
    /// <param name="value">The integer value when this returns true.</param>
    /// <returns>True if the token is an integer.</returns>
    public static bool ReadInt(JToken token, out int value)
    {
        value = 0;
        if (token == null || token.Type != JTokenType.Integer)
        {
            return false;
        }
        value = token.Value<int>();
        return true;
    }
}
