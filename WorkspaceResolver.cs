using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using System.Globalization;

namespace Hartsy.Extensions;

/// <summary>Turns a stored workspace (or draft) into what a client needs to use it: the values checked against this server's real parameter definitions using SwarmUI's own validation,
/// the chosen parts, the group switches, the state of the saved presets, and generation-ready parameters. This is where the work happens, so any client gets the same answer.</summary>
public static class WorkspaceResolver
{
    /// <summary>The ID of the model parameter, which is its own part rather than part of a group.</summary>
    public const string ModelParamId = "model";

    /// <summary>The most group IDs a part selection may name.</summary>
    public const int MaxSelectedGroups = 500;

    /// <summary>Which parts of a workspace to take. By default everything.</summary>
    public class Selection
    {
        /// <summary>True to take every part. When false, only the parts below are taken.</summary>
        public bool All = true;

        /// <summary>When not taking everything: whether to take the model.</summary>
        public bool Model;

        /// <summary>When not taking everything: whether to take the preset list.</summary>
        public bool Presets;

        /// <summary>When not taking everything: whether to take parameters that are not in any group.</summary>
        public bool Other;

        /// <summary>When not taking everything: the IDs of the groups to take.</summary>
        public HashSet<string> Groups = [];

        /// <summary>Returns whether the model part is taken.</summary>
        /// <returns>True if taken.</returns>
        public bool TakesModel()
        {
            return All || Model;
        }

        /// <summary>Returns whether the preset list is taken.</summary>
        /// <returns>True if taken.</returns>
        public bool TakesPresets()
        {
            return All || Presets;
        }

        /// <summary>Returns whether parameters outside every group are taken.</summary>
        /// <returns>True if taken.</returns>
        public bool TakesOther()
        {
            return All || Other;
        }

        /// <summary>Returns whether a group is taken.</summary>
        /// <param name="groupId">The group ID.</param>
        /// <returns>True if taken.</returns>
        public bool TakesGroup(string groupId)
        {
            return All || Groups.Contains(groupId);
        }
    }

    /// <summary>Reads a client's part selection. A missing selection means everything; a selection that is present means only what it names.</summary>
    /// <param name="rawParts">The raw selection: an object with optional bools 'model', 'presets', 'other', and a list of group IDs 'groups'. Null or missing for everything.</param>
    /// <param name="selection">The parsed selection when valid.</param>
    /// <param name="error">Set to the error object when this returns false; null otherwise.</param>
    /// <returns>True if the selection is valid.</returns>
    public static bool TryParseParts(JToken rawParts, out Selection selection, out JObject error)
    {
        selection = new Selection();
        error = null;
        if (rawParts == null || rawParts.Type == JTokenType.Null)
        {
            return true;
        }
        if (rawParts is not JObject parts)
        {
            error = WorkspaceStore.Error("invalid_parts", "'parts' must be an object.");
            return false;
        }
        selection.All = false;
        foreach (string flag in new string[] { "model", "presets", "other" })
        {
            JToken token = parts[flag];
            if (token != null && token.Type != JTokenType.Boolean)
            {
                error = WorkspaceStore.Error("invalid_parts", $"'parts.{flag}' must be true or false.");
                return false;
            }
        }
        selection.Model = parts["model"]?.Value<bool>() ?? false;
        selection.Presets = parts["presets"]?.Value<bool>() ?? false;
        selection.Other = parts["other"]?.Value<bool>() ?? false;
        JToken groups = parts["groups"];
        if (groups != null)
        {
            if (groups.Type != JTokenType.Array || groups.Count() > MaxSelectedGroups || groups.Any(g => g.Type != JTokenType.String))
            {
                error = WorkspaceStore.Error("invalid_parts", $"'parts.groups' must be a list of at most {MaxSelectedGroups} group IDs.");
                return false;
            }
            foreach (JToken group in groups)
            {
                selection.Groups.Add(group.ToString());
            }
        }
        return true;
    }

    /// <summary>Resolves a snapshot for the given user and part selection.</summary>
    /// <param name="session">The user's session, used for SwarmUI's per-user value checks (for example which models exist).</param>
    /// <param name="entry">The stored workspace the snapshot belongs to, or null.</param>
    /// <param name="snapshot">The snapshot to resolve: the workspace's own, or its draft's.</param>
    /// <param name="selection">Which parts to take.</param>
    /// <returns>The resolved data: workspace, values, groups, enable_groups, presets, params, skipped, unsupported, and parts.</returns>
    public static JObject Resolve(Session session, JObject entry, JObject snapshot, Selection selection)
    {
        T2IParamInput scratch = new(session);
        Dictionary<string, T2IParamGroup> knownGroups = CollectKnownGroups();
        JObject savedValues = (JObject)snapshot["values"];
        JObject savedGroups = (JObject)snapshot["groups"];
        JObject values = new();
        JObject groups = new();
        JObject paramsOut = new();
        JArray skipped = new();
        foreach (KeyValuePair<string, JToken> pair in savedValues)
        {
            string id = pair.Key;
            JObject saved = (JObject)pair.Value;
            bool known = T2IParamTypes.TryGetType(id, out T2IParamType type, scratch);
            if (!IsTaken(selection, id, known ? type : null))
            {
                continue;
            }
            if (!known)
            {
                skipped.Add(Skipped(id, "param", "This parameter does not exist on this server."));
                continue;
            }
            if (type.Permission is not null && !session.User.HasPermission(type.Permission))
            {
                skipped.Add(Skipped(id, "param", "You do not have permission to use this parameter."));
                continue;
            }
            string normalized;
            try
            {
                normalized = T2IParamTypes.ValidateParam(type, ToParamString(saved["value"]), session);
            }
            catch (SwarmReadableErrorException ex)
            {
                skipped.Add(Skipped(id, "param", ex.Message));
                continue;
            }
            values[id] = new JObject() { ["value"] = saved["value"].DeepClone(), ["enabled"] = saved["enabled"] };
            if (saved["enabled"].Value<bool>() && GroupsAllowParam(type.Group, savedGroups))
            {
                paramsOut[type.ID] = normalized;
            }
        }
        foreach (KeyValuePair<string, JToken> pair in savedGroups)
        {
            if (!selection.TakesGroup(pair.Key))
            {
                continue;
            }
            if (!knownGroups.ContainsKey(pair.Key))
            {
                skipped.Add(Skipped(pair.Key, "group", "This group does not exist on this server."));
                continue;
            }
            groups[pair.Key] = pair.Value.DeepClone();
        }
        JObject result = new()
        {
            ["values"] = values,
            ["groups"] = groups,
            ["enable_groups"] = selection.All ? new JArray() : GroupsToEnable(selection, savedGroups, knownGroups),
            ["presets"] = selection.TakesPresets() ? ResolvePresets(session.User, (JArray)snapshot["presets"]) : (JToken)JValue.CreateNull(),
            ["params"] = paramsOut,
            ["skipped"] = skipped,
            ["unsupported"] = snapshot["unsupported"].DeepClone(),
            ["parts"] = DescribeParts(snapshot, scratch)
        };
        if (entry != null)
        {
            result["workspace"] = WorkspaceStore.NetData(entry, false);
        }
        return result;
    }

    /// <summary>Returns whether a saved parameter is part of the selection.</summary>
    /// <param name="selection">The selection.</param>
    /// <param name="id">The saved parameter ID.</param>
    /// <param name="type">The parameter's definition on this server, or null if it is unknown here.</param>
    /// <returns>True if taken.</returns>
    public static bool IsTaken(Selection selection, string id, T2IParamType type)
    {
        if (id == ModelParamId)
        {
            return selection.TakesModel();
        }
        if (type?.Group is not null)
        {
            return selection.TakesGroup(type.Group.ID);
        }
        return selection.TakesOther();
    }

    /// <summary>Returns whether the toggle groups around a parameter allow it: no group it sits in (or inside) may be a toggle group that was switched off.</summary>
    /// <param name="group">The parameter's own group, or null.</param>
    /// <param name="savedGroups">The saved group switches.</param>
    /// <returns>True if no enclosing toggle group is off.</returns>
    public static bool GroupsAllowParam(T2IParamGroup group, JObject savedGroups)
    {
        for (T2IParamGroup current = group; current is not null; current = current.Parent)
        {
            if (current.Toggles && savedGroups[current.ID]?["enabled"]?.Type == JTokenType.Boolean && !savedGroups[current.ID]["enabled"].Value<bool>())
            {
                return false;
            }
        }
        return true;
    }

    /// <summary>Finds the toggle groups that must be switched on for a partial load: a chosen group that is on can sit inside a toggle group that was not chosen, and it only works if that parent is on too.</summary>
    /// <param name="selection">The selection (not "everything").</param>
    /// <param name="savedGroups">The saved group switches.</param>
    /// <param name="knownGroups">Every group on this server, by ID.</param>
    /// <returns>A list of { id, name, because: { id, name } }, each parent once.</returns>
    public static JArray GroupsToEnable(Selection selection, JObject savedGroups, Dictionary<string, T2IParamGroup> knownGroups)
    {
        JArray result = new();
        HashSet<string> seen = [];
        foreach (string groupId in selection.Groups)
        {
            if (!knownGroups.TryGetValue(groupId, out T2IParamGroup group))
            {
                continue;
            }
            JToken saved = savedGroups[groupId]?["enabled"];
            if (saved != null && saved.Type == JTokenType.Boolean && !saved.Value<bool>())
            {
                continue;
            }
            for (T2IParamGroup parent = group.Parent; parent is not null; parent = parent.Parent)
            {
                if (parent.Toggles && !selection.Groups.Contains(parent.ID) && seen.Add(parent.ID))
                {
                    result.Add(new JObject()
                    {
                        ["id"] = parent.ID,
                        ["name"] = parent.Name,
                        ["because"] = new JObject() { ["id"] = group.ID, ["name"] = group.Name }
                    });
                }
            }
        }
        return result;
    }

    /// <summary>Compares the presets saved in a workspace with the user's presets as they are now.</summary>
    /// <param name="user">The user whose presets to look up.</param>
    /// <param name="saved">The saved presets, each with a title and a fingerprint.</param>
    /// <returns>A list of { title, status } in saved order. Status is "ok", "changed" (the definition changed since saving), "missing" (the preset no longer exists), or "unverified" (saved by an earlier build that used another fingerprint).</returns>
    public static JArray ResolvePresets(User user, JArray saved)
    {
        JArray result = new();
        foreach (JToken item in saved)
        {
            string title = item["title"].ToString();
            T2IPreset current = user.GetPreset(title);
            string status;
            if (current is null)
            {
                status = "missing";
            }
            else
            {
                string fingerprint = item["fingerprint"]?.ToString() ?? "";
                if (!fingerprint.StartsWith(WorkspaceStore.FingerprintPrefix))
                {
                    status = "unverified";
                }
                else
                {
                    status = fingerprint == WorkspaceStore.FingerprintPreset(current) ? "ok" : "changed";
                }
            }
            result.Add(new JObject() { ["title"] = current?.Title ?? title, ["status"] = status });
        }
        return result;
    }

    /// <summary>Describes what a workspace contains, so a client can offer the parts to take: whether it has a model, presets, parameters outside any group, and which groups (parents before their children, with their depth).</summary>
    /// <param name="snapshot">The snapshot to describe.</param>
    /// <param name="scratch">A scratch parameter input, used to look up parameter definitions.</param>
    /// <returns>{ model, presets, other, groups: [{ id, name, parent, depth }] }.</returns>
    public static JObject DescribeParts(JObject snapshot, T2IParamInput scratch)
    {
        bool hasModel = false;
        bool hasOther = false;
        Dictionary<string, T2IParamGroup> present = [];
        foreach (KeyValuePair<string, JToken> pair in (JObject)snapshot["values"])
        {
            if (pair.Key == ModelParamId)
            {
                hasModel = true;
                continue;
            }
            if (!T2IParamTypes.TryGetType(pair.Key, out T2IParamType type, scratch) || type.Group is null)
            {
                hasOther = true;
                continue;
            }
            for (T2IParamGroup group = type.Group; group is not null; group = group.Parent)
            {
                present[group.ID] = group;
            }
        }
        JArray ordered = new();
        AddGroupsInOrder(present, null, 0, ordered);
        return new JObject() { ["model"] = hasModel, ["presets"] = true, ["other"] = hasOther, ["groups"] = ordered };
    }

    /// <summary>Adds the groups under a parent to a list, in SwarmUI's display order, each followed by its own children.</summary>
    /// <param name="present">The groups to list, by ID.</param>
    /// <param name="parentId">The parent whose children to add, or null for top-level groups.</param>
    /// <param name="depth">How deep this level is.</param>
    /// <param name="output">The list to add to.</param>
    public static void AddGroupsInOrder(Dictionary<string, T2IParamGroup> present, string parentId, int depth, JArray output)
    {
        IEnumerable<T2IParamGroup> level = present.Values.Where(g => g.Parent?.ID == parentId).OrderBy(g => g.OrderPriority).ThenBy(g => g.Name, StringComparer.Ordinal);
        foreach (T2IParamGroup group in level)
        {
            output.Add(new JObject() { ["id"] = group.ID, ["name"] = group.Name, ["parent"] = group.Parent?.ID, ["depth"] = depth });
            AddGroupsInOrder(present, group.ID, depth + 1, output);
        }
    }

    /// <summary>Collects every parameter group that exists on this server, including the parents of groups, by ID.</summary>
    /// <returns>The groups by ID.</returns>
    public static Dictionary<string, T2IParamGroup> CollectKnownGroups()
    {
        Dictionary<string, T2IParamGroup> result = [];
        foreach (T2IParamType type in T2IParamTypes.Types.Values)
        {
            for (T2IParamGroup group = type.Group; group is not null; group = group.Parent)
            {
                result[group.ID] = group;
            }
        }
        return result;
    }

    /// <summary>Builds a skipped-item entry.</summary>
    /// <param name="id">The parameter or group ID.</param>
    /// <param name="kind">'param' or 'group'.</param>
    /// <param name="reason">Why it was skipped, readable by a person.</param>
    /// <returns>{ id, kind, reason }.</returns>
    public static JObject Skipped(string id, string kind, string reason)
    {
        return new JObject() { ["id"] = id, ["kind"] = kind, ["reason"] = reason };
    }

    /// <summary>Converts a saved parameter value to the text form SwarmUI's parameter handling expects: true or false, a number, text, or a comma-separated list.</summary>
    /// <param name="value">The saved value.</param>
    /// <returns>The text form.</returns>
    public static string ToParamString(JToken value)
    {
        switch (value.Type)
        {
            case JTokenType.Boolean:
                return value.Value<bool>() ? "true" : "false";
            case JTokenType.Integer:
            case JTokenType.Float:
                return ((IConvertible)((JValue)value).Value).ToString(CultureInfo.InvariantCulture);
            case JTokenType.Array:
                return string.Join(",", ((JArray)value).Select(ToParamString));
            default:
                return value.ToString();
        }
    }
}
