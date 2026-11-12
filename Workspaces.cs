using System.IO;
using SwarmUI.Core;
using SwarmUI.WebAPI;

namespace Hartsy.Extensions;

/// <summary>Extension that adds named workspaces: saved snapshots of the generation configuration that can be loaded back later.</summary>
public class Workspaces : Extension
{
    /// <summary>Registers the browser assets for the workspace toolbar.
    /// SwarmUI only loads <see cref="Extension.ScriptFiles"/> as classic scripts, so the one registered script is a small entry that imports the ES modules, which are served as plain assets next to it.</summary>
    public override void OnPreInit()
    {
        ScriptFiles.Add("Assets/workspaces.js");
        StyleSheetFiles.Add("Assets/workspaces.css");
        foreach (string file in Directory.GetFiles($"{FilePath}Assets/modules", "*.js"))
        {
            OtherAssets.Add($"Assets/modules/{Path.GetFileName(file)}");
        }
    }

    /// <summary>Registers the workspace API routes. Reads do not refresh user activity; writes do.</summary>
    public override void OnInit()
    {
        API.RegisterAPICall(WorkspacesAPI.WorkspacesList, false, WorkspacesAPI.PermManageWorkspaces);
        API.RegisterAPICall(WorkspacesAPI.WorkspacesGet, false, WorkspacesAPI.PermManageWorkspaces);
        API.RegisterAPICall(WorkspacesAPI.WorkspacesCreate, true, WorkspacesAPI.PermManageWorkspaces);
        API.RegisterAPICall(WorkspacesAPI.WorkspacesUpdate, true, WorkspacesAPI.PermManageWorkspaces);
        API.RegisterAPICall(WorkspacesAPI.WorkspacesRename, true, WorkspacesAPI.PermManageWorkspaces);
        API.RegisterAPICall(WorkspacesAPI.WorkspacesStar, true, WorkspacesAPI.PermManageWorkspaces);
        API.RegisterAPICall(WorkspacesAPI.WorkspacesDelete, true, WorkspacesAPI.PermManageWorkspaces);
        API.RegisterAPICall(WorkspacesAPI.WorkspacesResolve, false, WorkspacesAPI.PermManageWorkspaces);
        API.RegisterAPICall(WorkspacesAPI.WorkspacesDraftSave, true, WorkspacesAPI.PermManageWorkspaces);
        API.RegisterAPICall(WorkspacesAPI.WorkspacesDraftList, false, WorkspacesAPI.PermManageWorkspaces);
        API.RegisterAPICall(WorkspacesAPI.WorkspacesDraftGet, false, WorkspacesAPI.PermManageWorkspaces);
        API.RegisterAPICall(WorkspacesAPI.WorkspacesDraftDelete, true, WorkspacesAPI.PermManageWorkspaces);
    }
}
