using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using SwarmUI.Utils;

namespace Hartsy.Extensions;

/// <summary>Per-user storage and validation for workspaces and their drafts, kept in the user's generic data. Every read-modify-write runs under the user's lock.</summary>
public static class WorkspaceStore
{
    /// <summary>Generic data category used for all workspace storage.</summary>
    public const string Category = "hartsy_workspaces";

    /// <summary>Generic data key holding the user's full workspace list.</summary>
    public const string Key = "list";

    /// <summary>Generic data key holding the user's drafts (unsaved changes), as a map of workspace ID to draft.</summary>
    public const string DraftKey = "drafts";

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

    /// <summary>Maximum number of drafts one user may keep (one per workspace).</summary>
    public const int MaxDrafts = 50;

    /// <summary>Maximum serialized size of a user's whole draft store, in bytes.</summary>
    public const int MaxDraftTotalBytes = 2 * 1024 * 1024;

    /// <summary>How long a draft is kept after it was last saved.</summary>
    public static readonly TimeSpan DraftMaxAge = TimeSpan.FromDays(14);

    /// <summary>Prefix of the fingerprints this build writes for presets. Fingerprints without it came from an earlier build and cannot be verified.</summary>
    public const string FingerprintPrefix = "v2-";

    /// <summary>Per-user lock objects, keyed by user ID.</summary>
    public static readonly ConcurrentDictionary<string, object> UserLocks = new();

    /// <summary>Returns the lock that guards the given user's workspace data. Hold it for the whole read, check, and write.</summary>
    /// <param name="user">The user whose lock to return.</param>
    /// <returns>The lock object.</returns>
    public static object GetLock(User user)
    {
        return UserLocks.GetOrAdd(user.UserID, _ => new object());
    }

    /// <summary>Loads the user's workspace list. Returns an empty list if none is stored.</summary>
    /// <param name="user">The user whose workspaces to load.</param>
    /// <returns>The stored workspace entries.</returns>
    public static JArray Load(User user)
    {
        string text = user.GetGenericData(Category, Key);
        if (string.IsNullOrWhiteSpace(text))
        {
            return new JArray();
        }
        return JArray.Parse(text);
    }

    /// <summary>Stores the user's full workspace list in one write. Fails when persistence is disabled, the list is over the size limit, or SwarmUI did not really store it.</summary>
    /// <param name="user">The user whose workspaces to save.</param>
    /// <param name="list">The complete list of stored workspace entries.</param>
    /// <param name="error">Set to the error object when this returns false; null otherwise.</param>
    /// <returns>True if the list was stored.</returns>
    public static bool TrySave(User user, JArray list, out JObject error)
    {
        return TryWrite(user, Key, list.ToString(Formatting.None), MaxTotalBytes, "Workspace storage is full. Delete some workspaces first.", out error);
    }

    /// <summary>Loads the user's drafts as a map of workspace ID to draft. Drafts older than <see cref="DraftMaxAge"/> and unreadable entries are left out.</summary>
    /// <param name="user">The user whose drafts to load.</param>
    /// <returns>The drafts.</returns>
    public static JObject LoadDrafts(User user)
    {
        JObject result = new();
        string text = user.GetGenericData(Category, DraftKey);
        if (string.IsNullOrWhiteSpace(text))
        {
            return result;
        }
        JObject stored;
        try
        {
            stored = JObject.Parse(text);
        }
        catch (JsonReaderException)
        {
            return result;
        }
        DateTime cutoff = DateTime.UtcNow - DraftMaxAge;
        foreach (KeyValuePair<string, JToken> pair in stored)
        {
            if (pair.Value is JObject draft && DateTime.TryParse(draft["savedAt"]?.ToString(), null, System.Globalization.DateTimeStyles.RoundtripKind, out DateTime savedAt) && savedAt.ToUniversalTime() > cutoff)
            {
                result[pair.Key] = draft;
            }
        }
        return result;
    }

    /// <summary>Stores the user's full draft map in one write, with the same checks as <see cref="TrySave"/>.</summary>
    /// <param name="user">The user whose drafts to save.</param>
    /// <param name="drafts">The complete draft map.</param>
    /// <param name="error">Set to the error object when this returns false; null otherwise.</param>
    /// <returns>True if the drafts were stored.</returns>
    public static bool TrySaveDrafts(User user, JObject drafts, out JObject error)
    {
        return TryWrite(user, DraftKey, drafts.ToString(Formatting.None), MaxDraftTotalBytes, "Draft storage is full. Save or discard some unsaved changes first.", out error);
    }

    /// <summary>Writes one generic-data value. SwarmUI's SaveGenericData returns without writing in some cases (for example a user who may no longer create sessions), so the write is read back and confirmed.</summary>
    /// <param name="user">The user to write for.</param>
    /// <param name="key">The generic data key.</param>
    /// <param name="text">The serialized value.</param>
    /// <param name="maxBytes">The largest allowed serialized size, in bytes.</param>
    /// <param name="fullMessage">The error message to give when the value is over the size limit.</param>
    /// <param name="error">Set to the error object when this returns false; null otherwise.</param>
    /// <returns>True if the value was stored.</returns>
    public static bool TryWrite(User user, string key, string text, int maxBytes, string fullMessage, out JObject error)
    {
        error = null;
        if (Program.NoPersist)
        {
            error = Error("storage_disabled", "Workspaces cannot be saved because SwarmUI is running with --no_persist.");
            return false;
        }
        if (Encoding.UTF8.GetByteCount(text) > maxBytes)
        {
            error = Error("quota_exceeded", fullMessage);
            return false;
        }
        user.SaveGenericData(Category, key, text);
        if (user.GetGenericData(Category, key) != text)
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
        if (HasUnsafeCharacters(name))
        {
            error = Error("invalid_name", "Workspace name cannot contain control characters, line breaks, or text-direction overrides.");
            return false;
        }
        return true;
    }

    /// <summary>Validates a snapshot's structure, types, and size. Parameter values are not checked here; they are checked against the server's parameter definitions when a workspace is resolved.</summary>
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
            if (preset.Type != JTokenType.Object || preset["title"]?.Type != JTokenType.String || (preset["fingerprint"] != null && preset["fingerprint"].Type != JTokenType.String))
            {
                error = Error("invalid_snapshot", "Each entry in 'presets' needs a string 'title'.");
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

    /// <summary>Replaces a validated snapshot's preset list with the presets as they exist now: each title is looked up in the user's own presets, the canonical title is stored, duplicates are dropped, and a fingerprint of the preset's current definition is stamped on, so a later load can tell whether the preset changed.</summary>
    /// <param name="user">The user whose presets to look up.</param>
    /// <param name="snapshot">The validated snapshot, changed in place.</param>
    /// <param name="error">Set to the error object when this returns false; null otherwise.</param>
    /// <returns>True if every preset exists.</returns>
    public static bool StampPresets(User user, JObject snapshot, out JObject error)
    {
        error = null;
        JArray stamped = new();
        HashSet<string> seen = [];
        foreach (JToken saved in (JArray)snapshot["presets"])
        {
            string title = saved["title"].ToString();
            T2IPreset preset = user.GetPreset(title);
            if (preset is null)
            {
                error = Error("invalid_snapshot", $"The preset '{title}' does not exist.");
                return false;
            }
            if (seen.Add(preset.Title.ToLowerFast()))
            {
                stamped.Add(new JObject() { ["title"] = preset.Title, ["fingerprint"] = FingerprintPreset(preset) });
            }
        }
        snapshot["presets"] = stamped;
        return true;
    }

    /// <summary>Fingerprints a preset's definition (its parameter map, with keys in a fixed order), so a load can tell whether the preset changed since the workspace was saved.</summary>
    /// <param name="preset">The preset.</param>
    /// <returns>The fingerprint, starting with <see cref="FingerprintPrefix"/>.</returns>
    public static string FingerprintPreset(T2IPreset preset)
    {
        string json = JsonConvert.SerializeObject(new SortedDictionary<string, string>(preset.ParamMap, StringComparer.Ordinal));
        return FingerprintPrefix + Utilities.HashSHA256(json.EncodeUTF8())[..16];
    }

    /// <summary>Finds a workspace by ID. Call only while holding the user's lock.</summary>
    /// <param name="list">The user's workspace list.</param>
    /// <param name="id">The workspace ID to find.</param>
    /// <param name="index">The entry's index in the list when found; -1 otherwise.</param>
    /// <param name="error">Set to the error object when this returns false; null otherwise.</param>
    /// <returns>True if the workspace exists.</returns>
    public static bool Find(JArray list, string id, out int index, out JObject error)
    {
        index = -1;
        error = null;
        for (int i = 0; i < list.Count; i++)
        {
            if (list[i]["id"]?.ToString() == id)
            {
                index = i;
                return true;
            }
        }
        error = Error("not_found", "No workspace with that ID exists.");
        return false;
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
        if (!Find(list, id, out index, out error))
        {
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

    /// <summary>Copies only the known snapshot fields (values, groups, presets, unsupported), so anything else in the input is dropped.</summary>
    /// <param name="source">A validated snapshot or stored entry.</param>
    /// <returns>A new object with a deep copy of those fields and the schema version.</returns>
    public static JObject CopySnapshotFields(JObject source)
    {
        return new JObject()
        {
            ["schemaVersion"] = CurrentSchemaVersion,
            ["values"] = source["values"].DeepClone(),
            ["groups"] = source["groups"].DeepClone(),
            ["presets"] = source["presets"].DeepClone(),
            ["unsupported"] = source["unsupported"].DeepClone()
        };
    }

    /// <summary>Builds a stored entry from a validated snapshot and server-owned metadata. Only known fields are copied, so anything else in the input is dropped.</summary>
    /// <param name="snapshot">The validated snapshot. Only its values, groups, presets, and unsupported fields are used.</param>
    /// <param name="id">Server-assigned workspace ID.</param>
    /// <param name="name">The trimmed workspace name.</param>
    /// <param name="revision">The revision to store.</param>
    /// <param name="createdAt">Creation timestamp (UTC, ISO 8601).</param>
    /// <param name="updatedAt">Last update timestamp (UTC, ISO 8601).</param>
    /// <param name="bookmarked">Whether the workspace is starred.</param>
    /// <returns>The entry to store.</returns>
    public static JObject BuildEntry(JObject snapshot, string id, string name, int revision, string createdAt, string updatedAt, bool bookmarked)
    {
        JObject entry = CopySnapshotFields(snapshot);
        entry["id"] = id;
        entry["name"] = name;
        entry["revision"] = revision;
        entry["createdAt"] = createdAt;
        entry["updatedAt"] = updatedAt;
        entry["bookmarked"] = bookmarked;
        return entry;
    }

    /// <summary>Builds the networkable form of a stored workspace, the same shape every route returns.</summary>
    /// <param name="entry">The stored entry.</param>
    /// <param name="includeSnapshot">True to include the full snapshot.</param>
    /// <returns>The workspace as sent to clients: id, name, revision, starred, created_at, updated_at, and optionally snapshot.</returns>
    public static JObject NetData(JObject entry, bool includeSnapshot)
    {
        JObject net = new()
        {
            ["id"] = entry["id"],
            ["name"] = entry["name"],
            ["revision"] = entry["revision"],
            ["starred"] = entry["bookmarked"]?.Type == JTokenType.Boolean && entry["bookmarked"].Value<bool>(),
            ["created_at"] = entry["createdAt"],
            ["updated_at"] = entry["updatedAt"]
        };
        if (includeSnapshot)
        {
            net["snapshot"] = CopySnapshotFields(entry);
        }
        return net;
    }

    /// <summary>Checks an optional star flag. A missing or null value means not starred.</summary>
    /// <param name="raw">The flag token supplied by the client.</param>
    /// <param name="starred">The flag when valid.</param>
    /// <param name="error">Set to the error object when this returns false; null otherwise.</param>
    /// <returns>True if the flag is valid.</returns>
    public static bool ValidateStarred(JToken raw, out bool starred, out JObject error)
    {
        starred = false;
        error = null;
        if (raw == null || raw.Type == JTokenType.Null)
        {
            return true;
        }
        if (raw.Type != JTokenType.Boolean)
        {
            error = Error("invalid_starred", "'starred' must be true or false.");
            return false;
        }
        starred = raw.Value<bool>();
        return true;
    }

    /// <summary>Returns whether text contains a character that has no place in a name: a control character (which includes NUL, newlines, tabs, and DEL),
    /// a line or paragraph separator, or a text-direction override or isolate, which can make text display as something it is not.
    /// Joiners such as the zero-width joiner stay allowed, because emoji and several scripts need them.</summary>
    /// <param name="text">The text to check.</param>
    /// <returns>True if such a character is present.</returns>
    public static bool HasUnsafeCharacters(string text)
    {
        foreach (char c in text)
        {
            // U+2028 and U+2029 are line and paragraph separators, U+202A to U+202E are the bidi embeddings and overrides, and U+2066 to U+2069 are the bidi isolates.
            if (char.IsControl(c) || c == (char)0x2028 || c == (char)0x2029 || (c >= (char)0x202A && c <= (char)0x202E) || (c >= (char)0x2066 && c <= (char)0x2069))
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>Checks that a token is an object whose entries are objects with a boolean 'enabled' field.</summary>
    /// <param name="map">The token to check.</param>
    /// <param name="label">Field name used in error messages.</param>
    /// <param name="requireValue">True if each entry must also have a 'value' field of a supported type.</param>
    /// <param name="problem">Set to a description of the first problem found; null otherwise.</param>
    /// <returns>True if the map is valid.</returns>
    public static bool ValidateSwitchMap(JToken map, string label, bool requireValue, out string problem)
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
            if (requireValue && !IsSupportedValue(item["value"]))
            {
                problem = $"'{label}.{entry.Key}.value' is required and must be a boolean, number, string, or list of strings and numbers.";
                return false;
            }
            if (!requireValue && item["parent"] != null && item["parent"].Type != JTokenType.String && item["parent"].Type != JTokenType.Null)
            {
                problem = $"'{label}.{entry.Key}.parent' must be a group ID or null.";
                return false;
            }
        }
        return true;
    }

    /// <summary>Returns whether a parameter value has a type a workspace can store: a boolean, number, string, or list of strings and numbers.</summary>
    /// <param name="value">The value token.</param>
    /// <returns>True if supported.</returns>
    public static bool IsSupportedValue(JToken value)
    {
        if (value == null)
        {
            return false;
        }
        switch (value.Type)
        {
            case JTokenType.Boolean:
            case JTokenType.Integer:
            case JTokenType.Float:
            case JTokenType.String:
                return true;
            case JTokenType.Array:
                foreach (JToken item in (JArray)value)
                {
                    if (item.Type != JTokenType.String && item.Type != JTokenType.Integer && item.Type != JTokenType.Float)
                    {
                        return false;
                    }
                }
                return true;
            default:
                return false;
        }
    }
}
