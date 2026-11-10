using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Text;

namespace Hartsy.Extensions;

/// <summary>Per-user storage for workspaces, kept in the user's generic data. Every read-modify-write runs under the user's lock.</summary>
public static class WorkspaceStore
{
    /// <summary>Generic data category used for all workspace storage.</summary>
    public const string Category = "hartsy_workspaces";

    /// <summary>Generic data key holding the user's full workspace list.</summary>
    public const string Key = "list";

    /// <summary>Snapshot schema version this build reads and writes.</summary>
    public const int CurrentSchemaVersion = 1;

    /// <summary>Maximum number of workspaces one user may store.</summary>
    public const int MaxWorkspaces = 200;

    /// <summary>Maximum serialized size of one snapshot, in bytes.</summary>
    public const int MaxSnapshotBytes = 256 * 1024;

    /// <summary>Maximum serialized size of a user's whole workspace list, in bytes.</summary>
    public const int MaxTotalBytes = 4 * 1024 * 1024;

    /// <summary>Maximum workspace name length, in characters.</summary>
    public const int MaxNameLength = 100;

    /// <summary>Maximum folder name length, in characters.</summary>
    public const int MaxFolderLength = 100;

    /// <summary>Per-user lock objects, keyed by user ID.</summary>
    private static readonly ConcurrentDictionary<string, object> UserLocks = new();

    /// <summary>Returns the lock that guards the given user's workspace list. Hold it for the whole read, check, and write.</summary>
    /// <param name="user">The user whose lock to return.</param>
    /// <returns>The lock object.</returns>
    public static object GetLock(User user)
    {
        return UserLocks.GetOrAdd(user.UserID, _ => new object());
    }

    /// <summary>Loads the user's workspace list. Returns an empty list if none is stored.</summary>
    /// <param name="user">The user whose workspaces to load.</param>
    /// <returns>The workspace entries.</returns>
    public static JArray Load(User user)
    {
        string text = user.GetGenericData(Category, Key);
        if (string.IsNullOrWhiteSpace(text))
        {
            return new JArray();
        }
        return JArray.Parse(text);
    }

    /// <summary>Stores the user's full list in one write. Fails when persistence is disabled or the list is over the size limit.</summary>
    /// <param name="user">The user whose workspaces to save.</param>
    /// <param name="list">The complete list of workspace entries.</param>
    /// <param name="error">Set to the error object when this returns false; null otherwise.</param>
    /// <returns>True if the list was stored.</returns>
    public static bool TrySave(User user, JArray list, out JObject error)
    {
        error = null;
        if (Program.NoPersist)
        {
            error = Error("storage_disabled", "Workspaces cannot be saved because SwarmUI is running with --no_persist.");
            return false;
        }
        string text = list.ToString(Formatting.None);
        if (Encoding.UTF8.GetByteCount(text) > MaxTotalBytes)
        {
            error = Error("quota_exceeded", "Workspace storage is full. Delete some workspaces first.");
            return false;
        }
        user.SaveGenericData(Category, Key, text);
        // SwarmUI's SaveGenericData returns without writing in some cases (for example a user who may no longer create sessions), so confirm the write before reporting success.
        if (user.GetGenericData(Category, Key) != text)
        {
            error = Error("storage_failed", "Workspaces could not be saved to your account. Nothing was changed.");
            return false;
        }
        return true;
    }

    /// <summary>Builds an error response with a stable ID for clients to branch on.</summary>
    /// <param name="errorId">Stable machine-readable error identifier.</param>
    /// <param name="message">Human-readable description.</param>
    /// <returns>The error object.</returns>
    public static JObject Error(string errorId, string message)
    {
        return new JObject() { ["error"] = message, ["error_id"] = errorId };
    }

    /// <summary>Checks a workspace name and returns it trimmed.</summary>
    /// <param name="raw">The name supplied by the client.</param>
    /// <param name="name">The trimmed name when valid.</param>
    /// <param name="error">Set to the error object when this returns false; null otherwise.</param>
    /// <returns>True if the name is valid.</returns>
    public static bool ValidateName(string raw, out string name, out JObject error)
    {
        name = (raw ?? "").Trim();
        error = null;
        if (name.Length < 1 || name.Length > MaxNameLength)
        {
            error = Error("invalid_name", $"Workspace name must be 1 to {MaxNameLength} characters.");
            return false;
        }
        return true;
    }

    /// <summary>Validates a snapshot's structure, types, and size. Does not check that the parameters or presets exist on this server.</summary>
    /// <param name="raw">The snapshot token supplied by the client.</param>
    /// <param name="error">Set to the error object when this returns false; null otherwise.</param>
    /// <returns>True if the snapshot is valid.</returns>
    public static bool ValidateSnapshot(JToken raw, out JObject error)
    {
        error = null;
        if (raw == null || raw.Type != JTokenType.Object)
        {
            error = Error("invalid_snapshot", "Snapshot must be an object.");
            return false;
        }
        JObject snap = (JObject)raw;
        JToken version = snap["schemaVersion"];
        if (version == null || version.Type != JTokenType.Integer)
        {
            error = Error("invalid_snapshot", "Snapshot must include an integer 'schemaVersion'.");
            return false;
        }
        int schema = version.Value<int>();
        if (schema > CurrentSchemaVersion)
        {
            error = Error("unsupported_schema", $"Snapshot schema version {schema} is newer than this extension supports ({CurrentSchemaVersion}).");
            return false;
        }
        if (schema != CurrentSchemaVersion)
        {
            error = Error("invalid_snapshot", $"Unknown snapshot schema version {schema}.");
            return false;
        }
        if (Encoding.UTF8.GetByteCount(snap.ToString(Formatting.None)) > MaxSnapshotBytes)
        {
            error = Error("snapshot_too_large", $"Snapshot is larger than {MaxSnapshotBytes / 1024} KB.");
            return false;
        }
        if (!ValidateSwitchMap(snap["values"], "values", true, out string problem))
        {
            error = Error("invalid_snapshot", problem);
            return false;
        }
        if (!ValidateSwitchMap(snap["groups"], "groups", false, out problem))
        {
            error = Error("invalid_snapshot", problem);
            return false;
        }
        JToken presets = snap["presets"];
        if (presets == null || presets.Type != JTokenType.Array)
        {
            error = Error("invalid_snapshot", "'presets' must be an array.");
            return false;
        }
        foreach (JToken preset in (JArray)presets)
        {
            if (preset.Type != JTokenType.Object || preset["title"]?.Type != JTokenType.String || preset["fingerprint"]?.Type != JTokenType.String)
            {
                error = Error("invalid_snapshot", "Each entry in 'presets' needs string 'title' and 'fingerprint' fields.");
                return false;
            }
        }
        JToken unsupported = snap["unsupported"];
        if (unsupported == null || unsupported.Type != JTokenType.Array)
        {
            error = Error("invalid_snapshot", "'unsupported' must be an array.");
            return false;
        }
        foreach (JToken item in (JArray)unsupported)
        {
            if (item.Type != JTokenType.String)
            {
                error = Error("invalid_snapshot", "Each entry in 'unsupported' must be a string.");
                return false;
            }
        }
        return true;
    }

    /// <summary>Finds a workspace by ID and checks its revision. Call only while holding the user's lock.</summary>
    /// <param name="list">The user's workspace list.</param>
    /// <param name="id">The workspace ID to find.</param>
    /// <param name="revision">The revision the client last saw.</param>
    /// <param name="index">The entry's index in the list when found; -1 otherwise.</param>
    /// <param name="error">Set to the error object when this returns false; null otherwise.</param>
    /// <returns>True if the workspace exists and the revision matches.</returns>
    public static bool FindChecked(JArray list, string id, int revision, out int index, out JObject error)
    {
        index = -1;
        error = null;
        for (int i = 0; i < list.Count; i++)
        {
            if (list[i]["id"]?.ToString() == id)
            {
                index = i;
                break;
            }
        }
        if (index < 0)
        {
            error = Error("not_found", "No workspace with that ID exists.");
            return false;
        }
        int current = list[index]["revision"]?.Value<int>() ?? 0;
        if (current != revision)
        {
            error = Error("revision_conflict", "This workspace was changed elsewhere. Reload it and try again.");
            error["current_revision"] = current;
            return false;
        }
        return true;
    }

    /// <summary>Builds a stored entry from a validated snapshot and server-owned metadata. Only known fields are copied, so anything else in the input is dropped.</summary>
    /// <param name="snapshot">The validated snapshot. Only its values, groups, presets, and unsupported fields are used.</param>
    /// <param name="id">Server-assigned workspace ID.</param>
    /// <param name="name">The trimmed workspace name.</param>
    /// <param name="revision">The revision to store.</param>
    /// <param name="createdAt">Creation timestamp (UTC, ISO 8601).</param>
    /// <param name="updatedAt">Last update timestamp (UTC, ISO 8601).</param>
    /// <param name="folder">The validated folder name, or empty for none.</param>
    /// <param name="bookmarked">Whether the workspace is bookmarked.</param>
    /// <returns>The entry to store.</returns>
    public static JObject BuildEntry(JObject snapshot, string id, string name, int revision, string createdAt, string updatedAt, string folder, bool bookmarked)
    {
        return new JObject()
        {
            ["schemaVersion"] = CurrentSchemaVersion,
            ["id"] = id,
            ["name"] = name,
            ["revision"] = revision,
            ["createdAt"] = createdAt,
            ["updatedAt"] = updatedAt,
            ["folder"] = folder,
            ["bookmarked"] = bookmarked,
            ["values"] = snapshot["values"].DeepClone(),
            ["groups"] = snapshot["groups"].DeepClone(),
            ["presets"] = snapshot["presets"].DeepClone(),
            ["unsupported"] = snapshot["unsupported"].DeepClone()
        };
    }

    /// <summary>Checks an optional folder name. A missing or null value means no folder.</summary>
    /// <param name="raw">The folder token supplied by the client.</param>
    /// <param name="folder">The trimmed folder name when valid (empty for none).</param>
    /// <param name="error">Set to the error object when this returns false; null otherwise.</param>
    /// <returns>True if the folder is valid.</returns>
    public static bool ValidateFolder(JToken raw, out string folder, out JObject error)
    {
        folder = "";
        error = null;
        if (raw == null || raw.Type == JTokenType.Null)
        {
            return true;
        }
        if (raw.Type != JTokenType.String)
        {
            error = Error("invalid_folder", "'folder' must be text.");
            return false;
        }
        folder = raw.ToString().Trim();
        if (folder.Length > MaxFolderLength || HasControlCharacters(folder))
        {
            error = Error("invalid_folder", $"A folder name can be at most {MaxFolderLength} characters, with no control characters.");
            return false;
        }
        return true;
    }

    /// <summary>Checks an optional bookmark flag. A missing or null value means not bookmarked.</summary>
    /// <param name="raw">The bookmark token supplied by the client.</param>
    /// <param name="bookmarked">The flag when valid.</param>
    /// <param name="error">Set to the error object when this returns false; null otherwise.</param>
    /// <returns>True if the flag is valid.</returns>
    public static bool ValidateBookmarked(JToken raw, out bool bookmarked, out JObject error)
    {
        bookmarked = false;
        error = null;
        if (raw == null || raw.Type == JTokenType.Null)
        {
            return true;
        }
        if (raw.Type != JTokenType.Boolean)
        {
            error = Error("invalid_bookmark", "'bookmarked' must be true or false.");
            return false;
        }
        bookmarked = raw.Value<bool>();
        return true;
    }

    /// <summary>Returns whether text contains any control character.</summary>
    /// <param name="text">The text to check.</param>
    /// <returns>True if a control character is present.</returns>
    private static bool HasControlCharacters(string text)
    {
        foreach (char c in text)
        {
            if (char.IsControl(c))
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>Checks that a token is an object whose entries are objects with a boolean 'enabled' field.</summary>
    /// <param name="map">The token to check.</param>
    /// <param name="label">Field name used in error messages.</param>
    /// <param name="requireValue">True if each entry must also have a 'value' field.</param>
    /// <param name="problem">Set to a description of the first problem found; null otherwise.</param>
    /// <returns>True if the map is valid.</returns>
    private static bool ValidateSwitchMap(JToken map, string label, bool requireValue, out string problem)
    {
        problem = null;
        if (map == null || map.Type != JTokenType.Object)
        {
            problem = $"'{label}' must be an object.";
            return false;
        }
        foreach (KeyValuePair<string, JToken> entry in (JObject)map)
        {
            JToken item = entry.Value;
            if (item == null || item.Type != JTokenType.Object)
            {
                problem = $"'{label}.{entry.Key}' must be an object.";
                return false;
            }
            if (item["enabled"]?.Type != JTokenType.Boolean)
            {
                problem = $"'{label}.{entry.Key}.enabled' must be a boolean.";
                return false;
            }
            if (requireValue && item["value"] == null)
            {
                problem = $"'{label}.{entry.Key}.value' is required.";
                return false;
            }
        }
        return true;
    }
}
