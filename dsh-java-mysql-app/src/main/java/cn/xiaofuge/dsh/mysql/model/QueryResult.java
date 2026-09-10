package cn.xiaofuge.dsh.mysql.model;

import java.util.List;

/**
 * 查询结果。
 * <p>rows 使用位置数组而非 Map，避免 JOIN 等场景下同名列（如 a.id / b.id）
 * 因 JSON key 冲突而丢列；渲染时按 columns 下标取值。</p>
 */
public record QueryResult(
        List<String> columns,
        List<List<Object>> rows,
        int affectedRows,
        long elapsedMs,
        boolean readOnly,
        String sql
) {
    public static QueryResult empty(String sql, boolean readOnly, long elapsedMs, int affectedRows) {
        return new QueryResult(List.of(), List.of(), affectedRows, elapsedMs, readOnly, sql);
    }
}
