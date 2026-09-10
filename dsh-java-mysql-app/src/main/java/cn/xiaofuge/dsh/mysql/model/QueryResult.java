package cn.xiaofuge.dsh.mysql.model;

import java.util.List;
import java.util.Map;

public record QueryResult(
        List<String> columns,
        List<Map<String, Object>> rows,
        int affectedRows,
        long elapsedMs,
        boolean readOnly,
        String sql
) {
    public static QueryResult empty(String sql, boolean readOnly, long elapsedMs, int affectedRows) {
        return new QueryResult(List.of(), List.of(), affectedRows, elapsedMs, readOnly, sql);
    }
}
