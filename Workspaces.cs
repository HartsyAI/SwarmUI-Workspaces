using SwarmUI.Core;
using SwarmUI.WebAPI;

namespace Hartsy.Extensions;

/// <summary>Extension that adds named workspaces: saved snapshots of the generation configuration that can be loaded back later.</summary>
public class Workspaces : Extension
{
    /// <summary>Registers the browser assets for the workspace toolbar.</summary>
    public override void OnPreInit()
    {
        ScriptFiles.Add("Assets/workspaces.js");
        StyleSheetFiles.Add("Assets/workspaces.css");
    }

    /// <summary>Registers the workspace API routes. Reads do not refresh user activity; writes do.</summary>
    public override void OnInit()
    {
        API.RegisterAPICall(WorkspacesAPI.WorkspacesList, false, WorkspacesAPI.PermManageWorkspaces);
        API.RegisterAPICall(WorkspacesAPI.WorkspacesCreate, true, WorkspacesAPI.PermManageWorkspaces);
        API.RegisterAPICall(WorkspacesAPI.WorkspacesUpdate, true, WorkspacesAPI.PermManageWorkspaces);
        API.RegisterAPICall(WorkspacesAPI.WorkspacesRename, true, WorkspacesAPI.PermManageWorkspaces);
        API.RegisterAPICall(WorkspacesAPI.WorkspacesDelete, true, WorkspacesAPI.PermManageWorkspaces);
        API.RegisterAPICall(WorkspacesAPI.WorkspacesImport, true, WorkspacesAPI.PermManageWorkspaces);
    }
}
