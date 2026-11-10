// Two-user isolation check for the Workspaces API. Run it against a THROWAWAY SwarmUI instance, never a real one:
// it creates the users "alice" and "bob" and creates and deletes workspaces for them.
//
// How to run: start a disposable SwarmUI (its own Data folder) with this extension, then:
//   node tests/two-user-isolation.mjs http://localhost:7801
// It signs in as the local admin, creates alice and bob, gets a real session for each (the admin "impersonateUser" option),
// and checks that neither can list, read, change or delete the other's workspaces, that identity fields sent by the client are ignored,
// and that requests without a valid session get nothing. It exits with code 1 if any check fails.
const base = process.argv[2] || 'http://localhost:7801';
async function call(route, body) {
    const r = await fetch(`${base}/API/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: r.status, json: await r.json().catch(() => null) };
}
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + JSON.stringify(detail)}`); };

const admin = (await call('GetNewSession', {})).json;
check('admin session obtained', admin && admin.session_id, admin);
for (const name of ['alice', 'bob']) {
    const r = (await call('AdminAddUser', { session_id: admin.session_id, name, password: `${name}-password-1`, role: 'user' })).json;
    check(`created user ${name}`, r && (r.success || /already exists/.test(r.error || '')), r);
}
const as = async name => { const r = (await call('GetNewSession', { impersonateUser: name })).json; if (!r || !r.session_id) { throw new Error(`no session for ${name}: ${JSON.stringify(r)}`); } return { sid: r.session_id, uid: r.user_id }; };
const alice = await as('alice');
const bob = await as('bob');
check('alice and bob are different users with different sessions', alice.uid != bob.uid && alice.sid != bob.sid, { alice: alice.uid, bob: bob.uid });
check('users are really alice and bob', alice.uid == 'alice' && bob.uid == 'bob', { alice: alice.uid, bob: bob.uid });

const snap = { schemaVersion: 1, values: { steps: { value: 20, enabled: true } }, groups: {}, presets: [], unsupported: [] };
const A = (route, body) => call(route, { session_id: alice.sid, ...body });
const B = (route, body) => call(route, { session_id: bob.sid, ...body });

// Start both users clean (only workspaces created by this test).
for (const [who, fn] of [['alice', A], ['bob', B]]) {
    const list = (await fn('WorkspacesList', {})).json.workspaces || [];
    for (const w of list) { await fn('WorkspacesDelete', { id: w.id, revision: w.revision }); }
}

const secret = (await A('WorkspacesCreate', { name: 'alice-secret', snapshot: { ...snap, values: { prompt: { value: 'ALICE PRIVATE PROMPT', enabled: true } } }, folder: 'private', bookmarked: true })).json;
check('alice created a workspace', secret && secret.success, secret);
const aid = secret.workspace.id;
const arev = secret.workspace.revision;

// Listing is per user.
const bobList1 = (await B('WorkspacesList', {})).json.workspaces;
check("bob's list does not contain alice's workspace", Array.isArray(bobList1) && bobList1.length == 0, bobList1);
check("bob's list does not contain alice's private prompt anywhere", !JSON.stringify(bobList1).includes('ALICE PRIVATE PROMPT'), bobList1);

// Identity smuggled in the request is ignored.
for (const extra of [{ user_id: 'alice' }, { userid: 'alice' }, { UserID: 'alice' }, { user: 'alice' }, { impersonateUser: 'alice' }, { username: 'alice' }]) {
    const r = (await B('WorkspacesList', extra)).json;
    check(`bob listing with ${JSON.stringify(extra)} still sees only bob's data`, Array.isArray(r.workspaces) && r.workspaces.length == 0, r);
}
const smuggled = (await B('WorkspacesCreate', { name: 'bob-smuggle', snapshot: snap, user_id: 'alice', UserID: 'alice' })).json;
check('bob creating with user_id=alice stores it for bob', smuggled && smuggled.success, smuggled);
const aliceAfterSmuggle = (await A('WorkspacesList', {})).json.workspaces;
check("...and it did not appear in alice's list", aliceAfterSmuggle.length == 1 && aliceAfterSmuggle[0].id == aid, aliceAfterSmuggle.map(w => w.name));

// Bob cannot touch alice's workspace by guessing her ID (and even knowing her revision).
const attempts = {
    WorkspacesUpdate: { id: aid, revision: arev, name: 'hacked', snapshot: snap },
    WorkspacesRename: { id: aid, revision: arev, name: 'hacked' },
    WorkspacesSetMeta: { id: aid, revision: arev, folder: 'hacked', bookmarked: false },
    WorkspacesDelete: { id: aid, revision: arev }
};
for (const [route, body] of Object.entries(attempts)) {
    const r = (await B(route, body)).json;
    check(`bob ${route} on alice's id is refused as not found`, r && r.error_id == 'not_found', r);
}
const aliceStill = (await A('WorkspacesList', {})).json.workspaces.find(w => w.id == aid);
check("alice's workspace is untouched (name, folder, star, revision, prompt)", aliceStill && aliceStill.name == 'alice-secret' && aliceStill.folder == 'private' && aliceStill.bookmarked === true && aliceStill.revision == arev && JSON.stringify(aliceStill).includes('ALICE PRIVATE PROMPT'), aliceStill);

// Both users may use the same names independently.
const sa = (await A('WorkspacesCreate', { name: 'same-name', snapshot: snap })).json;
const sb = (await B('WorkspacesCreate', { name: 'same-name', snapshot: snap })).json;
check('both users can have a workspace with the same name', sa.success && sb.success && sa.workspace.id != sb.workspace.id, { sa, sb });
const bobList2 = (await B('WorkspacesList', {})).json.workspaces.map(w => w.name).sort();
check("bob sees exactly his own workspaces", JSON.stringify(bobList2) == JSON.stringify(['bob-smuggle', 'same-name']), bobList2);
const aliceList2 = (await A('WorkspacesList', {})).json.workspaces.map(w => w.name).sort();
check("alice sees exactly her own workspaces", JSON.stringify(aliceList2) == JSON.stringify(['alice-secret', 'same-name']), aliceList2);

// Bob deleting his same-named workspace leaves alice's.
const bsame = (await B('WorkspacesList', {})).json.workspaces.find(w => w.name == 'same-name');
await B('WorkspacesDelete', { id: bsame.id, revision: bsame.revision });
const aliceList3 = (await A('WorkspacesList', {})).json.workspaces.map(w => w.name).sort();
check("bob deleting his 'same-name' leaves alice's", aliceList3.includes('same-name') && aliceList3.includes('alice-secret'), aliceList3);

// Requests without a valid session get nothing.
const noSession = await call('WorkspacesList', {});
check('no session id: refused, no data', noSession.status != 200 || !noSession.json || !noSession.json.workspaces, noSession);
const badSession = await call('WorkspacesList', { session_id: 'not-a-real-session' });
check('invalid session id: refused, no data', !badSession.json || !badSession.json.workspaces, badSession);

// Clean up what this test created.
for (const [fn] of [[A], [B]]) {
    const list = (await fn('WorkspacesList', {})).json.workspaces || [];
    for (const w of list) { await fn('WorkspacesDelete', { id: w.id, revision: w.revision }); }
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
