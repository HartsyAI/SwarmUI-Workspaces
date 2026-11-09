using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.WebAPI;
using System;
using System.Threading.Tasks;

namespace Hartsy.Extensions;

/// <summary>API routes for listing, creating, updating, renaming, deleting, and importing the user's workspaces.</summary>
[API.APIClass("Routes for managing the user's saved workspaces.")]
public static class WorkspacesAPI
{
    /// <summary>Permission to list, save, and delete the user's own workspaces.</summary>
    public static PermInfo PermManageWorkspaces = Permissions.Register(new("workspaces_manage_workspaces", "[Workspaces] Manage Workspaces", "Allows this user to list, save, and delete their own workspaces.", PermissionDefault.USER, Permissions.GroupUser));

    /// <summary>Returns all of the user's saved workspaces.</summary>
    [API.APIDescription("Returns all of the user's saved workspaces.", "\"workspaces\": [ { \"id\": \"abc123\", \"name\": \"Video\", \"revision\": 1, \"schemaVersion\": 1, \"values\": { }, \"groups\": { }, \"presets\": [ ], \"unsupported\": [ ] } ]")]
    public static Task<JObject> WorkspacesList(Session session)
    {
        lock (WorkspaceStore.GetLock(session.User))
        {
            return Task.FromResult(new JObject() { ["workspaces"] = WorkspaceStore.Load(session.User) });
        }
    }

    /// <summary>Creates a workspace from a snapshot. The server assigns the ID, revision 1, and timestamps.</summary>
    [API.APIDescription("Creates a workspace. Send 'name' (string) and 'snapshot' (object, schema version 1), and optionally 'folder' (string), 'tags' (string list), and 'bookmarked' (bool). Returns the stored workspace.", "\"success\": true, \"workspace\": { \"id\": \"abc123\", \"revision\": 1 }")]
    public static Task<JObject> WorkspacesCreate(Session session,
        [API.APIParameter("Raw body: 'name' (string), 'snapshot' (object), and optional 'folder', 'tags', 'bookmarked'.")] JObject raw)
    {
        if (!WorkspaceStore.ValidateName(raw["name"]?.ToString(), out string name, out JObject nameError))
        {
            return Task.FromResult(nameError);
        }
        if (!WorkspaceStore.ValidateSnapshot(raw["snapshot"], out JObject snapError))
        {
            return Task.FromResult(snapError);
        }
        if (!WorkspaceStore.ValidateFolder(raw["folder"], out string folder, out JObject folderError))
        {
            return Task.FromResult(folderError);
        }
        if (!WorkspaceStore.ValidateTags(raw["tags"], out JArray tags, out JObject tagsError))
        {
            return Task.FromResult(tagsError);
        }
        if (!WorkspaceStore.ValidateBookmarked(raw["bookmarked"], out bool bookmarked, out JObject bookmarkError))
        {
            return Task.FromResult(bookmarkError);
        }
        JObject snapshot = (JObject)raw["snapshot"];
        lock (WorkspaceStore.GetLock(session.User))
        {
            JArray list = WorkspaceStore.Load(session.User);
            if (list.Count >= WorkspaceStore.MaxWorkspaces)
            {
                return Task.FromResult(WorkspaceStore.Error("quota_exceeded", $"You can store at most {WorkspaceStore.MaxWorkspaces} workspaces."));
            }
            string now = DateTime.UtcNow.ToString("o");
            JObject entry = WorkspaceStore.BuildEntry(snapshot, Guid.NewGuid().ToString("N"), name, 1, now, now, folder, tags, bookmarked);
            list.Add(entry);
            if (!WorkspaceStore.TrySave(session.User, list, out JObject saveError))
            {
                return Task.FromResult(saveError);
            }
            return Task.FromResult(new JObject() { ["success"] = true, ["workspace"] = entry });
        }
    }

    /// <summary>Replaces a workspace's name and snapshot. The revision must match the stored one.</summary>
    [API.APIDescription("Updates a workspace. Send 'id', 'revision' (the revision you last saw), 'name', and 'snapshot'. Returns the new revision.", "\"success\": true, \"workspace\": { \"id\": \"abc123\", \"revision\": 2 }")]
    public static Task<JObject> WorkspacesUpdate(Session session,
        [API.APIParameter("Raw body: 'id' (string), 'revision' (int), 'name' (string), and 'snapshot' (object).")] JObject raw)
    {
        string id = raw["id"]?.ToString() ?? "";
        if (!ReadInt(raw["revision"], out int revision))
        {
            return Task.FromResult(WorkspaceStore.Error("invalid_revision", "'revision' must be an integer."));
        }
        if (!WorkspaceStore.ValidateName(raw["name"]?.ToString(), out string name, out JObject nameError))
        {
            return Task.FromResult(nameError);
        }
        if (!WorkspaceStore.ValidateSnapshot(raw["snapshot"], out JObject snapError))
        {
            return Task.FromResult(snapError);
        }
        JObject snapshot = (JObject)raw["snapshot"];
        lock (WorkspaceStore.GetLock(session.User))
        {
            JArray list = WorkspaceStore.Load(session.User);
            if (!WorkspaceStore.FindChecked(list, id, revision, out int index, out JObject findError))
            {
                return Task.FromResult(findError);
            }
            JObject current = (JObject)list[index];
            string now = DateTime.UtcNow.ToString("o");
            // Saving settings keeps the workspace's organization (folder, tags, bookmark) as it is.
            string folder = current["folder"]?.ToString() ?? "";
            JArray tags = current["tags"] as JArray ?? new JArray();
            bool bookmarked = current["bookmarked"]?.Type == JTokenType.Boolean && current["bookmarked"].Value<bool>();
            JObject entry = WorkspaceStore.BuildEntry(snapshot, id, name, revision + 1, current["createdAt"]?.ToString() ?? now, now, folder, tags, bookmarked);
            list[index] = entry;
            if (!WorkspaceStore.TrySave(session.User, list, out JObject saveError))
            {
                return Task.FromResult(saveError);
            }
            return Task.FromResult(new JObject() { ["success"] = true, ["workspace"] = entry });
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
        lock (WorkspaceStore.GetLock(session.User))
        {
            JArray list = WorkspaceStore.Load(session.User);
            if (!WorkspaceStore.FindChecked(list, id, revision, out int index, out JObject findError))
            {
                return Task.FromResult(findError);
            }
            JObject current = (JObject)list[index];
            current["name"] = trimmed;
            current["revision"] = revision + 1;
            current["updatedAt"] = DateTime.UtcNow.ToString("o");
            if (!WorkspaceStore.TrySave(session.User, list, out JObject saveError))
            {
                return Task.FromResult(saveError);
            }
            return Task.FromResult(new JObject() { ["success"] = true, ["revision"] = revision + 1 });
        }
    }

    /// <summary>Sets a workspace's folder, tags, and bookmark without touching its saved settings. The revision must match. Fields left out are unchanged.</summary>
    [API.APIDescription("Sets a workspace's folder, tags, and bookmark. Send 'id', 'revision', and any of 'folder' (string), 'tags' (string list), 'bookmarked' (bool); fields left out are unchanged. Returns the new revision.", "\"success\": true, \"revision\": 2")]
    public static Task<JObject> WorkspacesSetMeta(Session session,
        [API.APIParameter("Raw body: 'id' (string), 'revision' (int), and any of 'folder', 'tags', 'bookmarked'.")] JObject raw)
    {
        string id = raw["id"]?.ToString() ?? "";
        if (!ReadInt(raw["revision"], out int revision))
        {
            return Task.FromResult(WorkspaceStore.Error("invalid_revision", "'revision' must be an integer."));
        }
        string folder = "";
        JArray tags = null;
        bool bookmarked = false;
        bool hasFolder = raw.ContainsKey("folder");
        bool hasTags = raw.ContainsKey("tags");
        bool hasBookmarked = raw.ContainsKey("bookmarked");
        if (hasFolder && !WorkspaceStore.ValidateFolder(raw["folder"], out folder, out JObject folderError))
        {
            return Task.FromResult(folderError);
        }
        if (hasTags && !WorkspaceStore.ValidateTags(raw["tags"], out tags, out JObject tagsError))
        {
            return Task.FromResult(tagsError);
        }
        if (hasBookmarked && !WorkspaceStore.ValidateBookmarked(raw["bookmarked"], out bookmarked, out JObject bookmarkError))
        {
            return Task.FromResult(bookmarkError);
        }
        lock (WorkspaceStore.GetLock(session.User))
        {
            JArray list = WorkspaceStore.Load(session.User);
            if (!WorkspaceStore.FindChecked(list, id, revision, out int index, out JObject findError))
            {
                return Task.FromResult(findError);
            }
            JObject current = (JObject)list[index];
            if (hasFolder)
            {
                current["folder"] = folder;
            }
            if (hasTags)
            {
                current["tags"] = tags;
            }
            if (hasBookmarked)
            {
                current["bookmarked"] = bookmarked;
            }
            current["revision"] = revision + 1;
            current["updatedAt"] = DateTime.UtcNow.ToString("o");
            if (!WorkspaceStore.TrySave(session.User, list, out JObject saveError))
            {
                return Task.FromResult(saveError);
            }
            return Task.FromResult(new JObject() { ["success"] = true, ["revision"] = revision + 1 });
        }
    }

    /// <summary>Deletes a workspace. The revision must match.</summary>
    [API.APIDescription("Deletes a workspace.", "\"success\": true")]
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
            // The workspace is gone, so drop its thumbnail too. Best effort: a leftover thumbnail is harmless, since it is only ever served for existing workspaces.
            JObject thumbs = WorkspaceStore.LoadThumbs(session.User);
            if (thumbs.Remove(id))
            {
                WorkspaceStore.TrySaveThumbs(session.User, thumbs, out JObject _);
            }
            return Task.FromResult(new JObject() { ["success"] = true });
        }
    }

    /// <summary>Returns the thumbnails of the user's existing workspaces. Fetched separately from the list so the list stays small.</summary>
    [API.APIDescription("Returns thumbnails as a map of workspace ID to a small JPEG data URL, only for workspaces that exist.", "\"thumbnails\": { \"abc123\": \"data:image/jpeg;base64,...\" }")]
    public static Task<JObject> WorkspacesThumbnails(Session session)
    {
        lock (WorkspaceStore.GetLock(session.User))
        {
            JArray list = WorkspaceStore.Load(session.User);
            JObject thumbs = WorkspaceStore.LoadThumbs(session.User);
            JObject result = new();
            foreach (JToken workspace in list)
            {
                string id = workspace["id"]?.ToString();
                if (id != null && thumbs[id]?.Type == JTokenType.String)
                {
                    result[id] = thumbs[id];
                }
            }
            return Task.FromResult(new JObject() { ["thumbnails"] = result });
        }
    }

    /// <summary>Sets or removes a workspace's thumbnail. This does not change the workspace or its revision.</summary>
    [API.APIDescription("Sets or removes a workspace's thumbnail. Send 'id' and 'thumbnail' (a small JPEG data URL), or an empty 'thumbnail' to remove it. The workspace and its revision are not changed.", "\"success\": true")]
    public static Task<JObject> WorkspacesSetThumbnail(Session session,
        [API.APIParameter("Raw body: 'id' (string) and 'thumbnail' (JPEG data URL, or empty to remove).")] JObject raw)
    {
        string id = raw["id"]?.ToString() ?? "";
        JToken thumbToken = raw["thumbnail"];
        if (thumbToken != null && thumbToken.Type != JTokenType.Null && thumbToken.Type != JTokenType.String)
        {
            return Task.FromResult(WorkspaceStore.Error("invalid_thumbnail", "'thumbnail' must be a JPEG data URL, or empty to remove it."));
        }
        string thumbnail = thumbToken?.Type == JTokenType.String ? thumbToken.ToString() : "";
        if (thumbnail != "" && !WorkspaceStore.ValidateThumbnail(thumbnail, out JObject thumbError))
        {
            return Task.FromResult(thumbError);
        }
        lock (WorkspaceStore.GetLock(session.User))
        {
            JArray list = WorkspaceStore.Load(session.User);
            bool exists = false;
            foreach (JToken workspace in list)
            {
                if (workspace["id"]?.ToString() == id)
                {
                    exists = true;
                    break;
                }
            }
            if (!exists)
            {
                return Task.FromResult(WorkspaceStore.Error("not_found", "No workspace with that ID exists."));
            }
            JObject thumbs = WorkspaceStore.LoadThumbs(session.User);
            if (thumbnail == "")
            {
                thumbs.Remove(id);
            }
            else
            {
                thumbs[id] = thumbnail;
            }
            if (!WorkspaceStore.TrySaveThumbs(session.User, thumbs, out JObject saveError))
            {
                return Task.FromResult(saveError);
            }
            return Task.FromResult(new JObject() { ["success"] = true });
        }
    }

    /// <summary>Imports workspaces from a file. Every entry is validated before anything is written, and the write is a single save.</summary>
    [API.APIDescription("Imports workspaces. Send 'workspaces' (array of exported workspace objects). Each entry is validated first; IDs, revisions, and timestamps are reassigned. Either all entries are stored or none are.", "\"success\": true, \"imported\": 3")]
    public static Task<JObject> WorkspacesImport(Session session,
        [API.APIParameter("Raw body: 'workspaces' (array of workspace objects).")] JObject raw)
    {
        if (!(raw["workspaces"] is JArray incoming) || incoming.Count == 0)
        {
            return Task.FromResult(WorkspaceStore.Error("invalid_import", "Import must contain a non-empty 'workspaces' array."));
        }
        if (incoming.Count > WorkspaceStore.MaxImportCount)
        {
            return Task.FromResult(WorkspaceStore.Error("quota_exceeded", $"An import can contain at most {WorkspaceStore.MaxImportCount} workspaces."));
        }
        string[] names = new string[incoming.Count];
        string[] folders = new string[incoming.Count];
        JArray[] tagLists = new JArray[incoming.Count];
        bool[] bookmarks = new bool[incoming.Count];
        for (int i = 0; i < incoming.Count; i++)
        {
            if (!WorkspaceStore.ValidateName(incoming[i]["name"]?.ToString(), out names[i], out JObject nameError))
            {
                return Task.FromResult(MarkImportEntry(nameError, i));
            }
            if (!WorkspaceStore.ValidateSnapshot(incoming[i], out JObject snapError))
            {
                return Task.FromResult(MarkImportEntry(snapError, i));
            }
            if (!WorkspaceStore.ValidateFolder(incoming[i]["folder"], out folders[i], out JObject folderError))
            {
                return Task.FromResult(MarkImportEntry(folderError, i));
            }
            if (!WorkspaceStore.ValidateTags(incoming[i]["tags"], out tagLists[i], out JObject tagsError))
            {
                return Task.FromResult(MarkImportEntry(tagsError, i));
            }
            if (!WorkspaceStore.ValidateBookmarked(incoming[i]["bookmarked"], out bookmarks[i], out JObject bookmarkError))
            {
                return Task.FromResult(MarkImportEntry(bookmarkError, i));
            }
        }
        lock (WorkspaceStore.GetLock(session.User))
        {
            JArray list = WorkspaceStore.Load(session.User);
            if (list.Count + incoming.Count > WorkspaceStore.MaxWorkspaces)
            {
                return Task.FromResult(WorkspaceStore.Error("quota_exceeded", $"This import would exceed the limit of {WorkspaceStore.MaxWorkspaces} workspaces."));
            }
            string now = DateTime.UtcNow.ToString("o");
            for (int i = 0; i < incoming.Count; i++)
            {
                list.Add(WorkspaceStore.BuildEntry((JObject)incoming[i], Guid.NewGuid().ToString("N"), names[i], 1, now, now, folders[i], tagLists[i], bookmarks[i]));
            }
            if (!WorkspaceStore.TrySave(session.User, list, out JObject saveError))
            {
                return Task.FromResult(saveError);
            }
            return Task.FromResult(new JObject() { ["success"] = true, ["imported"] = incoming.Count });
        }
    }

    /// <summary>Tags a validation error with the import entry it came from.</summary>
    /// <param name="error">The error object from validation.</param>
    /// <param name="index">Position of the bad entry in the import file.</param>
    /// <returns>The same error object, with the index and import error ID set.</returns>
    private static JObject MarkImportEntry(JObject error, int index)
    {
        error["error_id"] = "invalid_import";
        error["error"] = $"Entry {index}: {error["error"]}";
        error["index"] = index;
        return error;
    }

    /// <summary>Reads an integer field from a raw JSON token.</summary>
    /// <param name="token">The token to read.</param>
    /// <param name="value">The integer value when this returns true.</param>
    /// <returns>True if the token is an integer.</returns>
    private static bool ReadInt(JToken token, out int value)
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
