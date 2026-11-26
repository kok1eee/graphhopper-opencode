import { describe, expect, test } from "bun:test";
import { findWorkspace, moveToRepo, parseCreatedId, parseWorkspaceList, type RunResult } from "./herdr";

const listJson = JSON.stringify({
  id: "cli:workspace:list",
  result: {
    workspaces: [
      { workspace_id: "ws-1", cwd: "/Users/x/amu-repos/amu-tool", label: "amu-tool" },
      { workspace_id: "ws-2", cwd: "/Users/x/dotfiles", label: "dotfiles" },
    ],
  },
});

describe("board/herdr: ワークスペースの対応付け", () => {
  test("入れ子の応答から workspace_id と cwd を拾う", () => {
    expect(parseWorkspaceList(listJson)).toEqual([
      { id: "ws-1", cwd: "/Users/x/amu-repos/amu-tool", label: "amu-tool" },
      { id: "ws-2", cwd: "/Users/x/dotfiles", label: "dotfiles" },
    ]);
    expect(parseWorkspaceList("not json")).toEqual([]);
  });

  test("同じリポジトリの下を作業フォルダにしていれば当てる（深い方を選ぶ）", () => {
    const list = [
      { id: "a", cwd: "/Users/x/amu-repos", label: null },
      { id: "b", cwd: "/Users/x/amu-repos/amu-tool", label: "amu-tool" },
      { id: "c", cwd: "/Users/x/amu-repos/amu-tool2", label: null },
    ];
    expect(findWorkspace(list, "/Users/x/amu-repos/amu-tool")?.id).toBe("b");
    expect(findWorkspace(list, "/Users/x/amu-repos/new")?.id).toBe("a");
    expect(findWorkspace(list, "/Users/x/elsewhere")).toBeNull();
  });

  test("親・子しか無いときは一番近いものを選ぶ", () => {
    // 親: 遠い親（/Users/x）と近い親（/Users/x/amu-repos）→ 近い方
    const parents = [
      { id: "far", cwd: "/Users/x", label: null },
      { id: "near", cwd: "/Users/x/amu-repos", label: null },
    ];
    expect(findWorkspace(parents, "/Users/x/amu-repos/amu-tool")?.id).toBe("near");
    // 子: 深い子（…/a/b）と浅い子（…/a）→ 浅い方
    const children = [
      { id: "deep", cwd: "/Users/x/amu-repos/amu-tool/a/b", label: null },
      { id: "shallow", cwd: "/Users/x/amu-repos/amu-tool/a", label: null },
    ];
    expect(findWorkspace(children, "/Users/x/amu-repos/amu-tool")?.id).toBe("shallow");
  });
});

describe("board/herdr: 移動", () => {
  function recorder(replies: RunResult[]): { calls: string[][]; run: (argv: string[]) => RunResult } {
    const calls: string[][] = [];
    let i = 0;
    return {
      calls,
      run: (argv) => {
        calls.push(argv);
        const r = replies[Math.min(i, replies.length - 1)]!;
        i++;
        return r;
      },
    };
  }
  const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });

  test("既存があれば focus する（作成しない）", () => {
    const r = recorder([ok(listJson), ok()]);
    const res = moveToRepo("/Users/x/amu-repos/amu-tool", "amu-tool", r.run);
    expect(res.action).toBe("focused");
    expect(r.calls[1]).toEqual(["workspace", "focus", "ws-1"]);
    expect(r.calls.some((c) => c[0] === "workspace" && c[1] === "create")).toBe(false);
  });

  test("無ければ cwd 付きで作って移る", () => {
    const r = recorder([
      ok(listJson),
      ok(JSON.stringify({ result: { workspace: { workspace_id: "ws-9" } } })),
    ]);
    const res = moveToRepo("/Users/x/other-repo", "other-repo", r.run);
    expect(res).toEqual({ action: "created", id: "ws-9", message: "other-repo を開いて移りました" });
    expect(r.calls[1]).toEqual([
      "workspace",
      "create",
      "--cwd",
      "/Users/x/other-repo",
      "--label",
      "other-repo",
      "--focus",
    ]);
  });

  test("herdr が失敗したら理由を返す（throw しない）", () => {
    const r = recorder([{ status: 1, stdout: "", stderr: "no herdr server is running" }]);
    const res = moveToRepo("/Users/x/other-repo", "other-repo", r.run);
    expect(res.action).toBe("failed");
    expect(res.message).toContain("no herdr server is running");
    // 一覧も作成も失敗したら、一覧側の理由も残す
    expect(res.message).toContain("一覧も取れない");
  });

  test("focus が失敗したら作成に進まず理由を返す", () => {
    const r = recorder([ok(listJson), { status: 1, stdout: "", stderr: "focus denied" }]);
    const res = moveToRepo("/Users/x/amu-repos/amu-tool", "amu-tool", r.run);
    expect(res.action).toBe("failed");
    expect(res.message).toContain("focus denied");
    expect(r.calls.length).toBe(2);
  });

  test("一覧が失敗しても作成で復帰する", () => {
    const r = recorder([
      { status: 1, stdout: "", stderr: "socket down" },
      ok(JSON.stringify({ result: { workspace: { workspace_id: "ws-3" } } })),
    ]);
    const res = moveToRepo("/Users/x/new-repo", "new-repo", r.run);
    expect(res).toEqual({ action: "created", id: "ws-3", message: "new-repo を開いて移りました" });
  });

  test("作成の応答に id が無くても成功として扱う", () => {
    const r = recorder([ok(listJson), ok(JSON.stringify({ result: { workspace: {} } }))]);
    const res = moveToRepo("/Users/x/new-repo", "new-repo", r.run);
    expect(res.action).toBe("created");
    expect(res.id).toBeUndefined();
    expect(parseCreatedId("not json")).toBeNull();
    expect(parseCreatedId(JSON.stringify({ result: { workspace: { workspace_id: "w1" } } }))).toBe("w1");
    expect(parseCreatedId(JSON.stringify({ result: { nested: { id: "w2" } } }))).toBe("w2");
  });
});
