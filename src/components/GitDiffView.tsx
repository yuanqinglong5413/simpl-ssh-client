import type { GitDiffResult } from "../types";

type Props = {
  diffs: GitDiffResult[];
};

/**
 * 渲染 unified diff 输出：绿色增行、红色删行、灰色上下文。
 */
export function GitDiffView({ diffs }: Props) {
  if (diffs.length === 0) {
    return <div className="git-diff-empty">无 diff</div>;
  }

  return (
    <div className="git-diff-view">
      {diffs.map((d, i) => (
        <div key={i} className="git-diff-block">
          <pre className="git-diff-pre">
            {d.diff.split("\n").map((line, j) => {
              let cls = "diff-ctx";
              if (line.startsWith("+") && !line.startsWith("+++")) cls = "diff-add";
              else if (line.startsWith("-") && !line.startsWith("---")) cls = "diff-del";
              else if (line.startsWith("@@")) cls = "diff-hunk";
              else if (line.startsWith("+++") || line.startsWith("---")) cls = "diff-header";
              return (
                <div key={j} className={`diff-line ${cls}`}>
                  {line}
                </div>
              );
            })}
          </pre>
        </div>
      ))}
    </div>
  );
}
