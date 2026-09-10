package cn.xiaofuge.dsh.mysql.plugin;

import cn.xiaofuge.deepseek.harness.domain.model.entity.AbstractTool;
import cn.xiaofuge.deepseek.harness.domain.model.entity.ToolDefinition;
import cn.xiaofuge.deepseek.harness.domain.spi.AbstractHarnessPlugin;
import cn.xiaofuge.deepseek.harness.domain.spi.PluginContext;
import cn.xiaofuge.deepseek.harness.domain.spi.PluginHookResult;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;

public class DshMysqlPlugin extends AbstractHarnessPlugin {
    public static final String PLUGIN_ID = "dsh-java-mysql-plugin";

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .build();

    public DshMysqlPlugin() {
        super(PLUGIN_ID);
    }

    @Override
    public List<ToolDefinition> tools() {
        return List.of(
                new ListConnectionsTool(),
                new ReadQueryTool(),
                new ExplainQueryTool(),
                new PerformanceTool(),
                new SqlReviewTool()
        );
    }

    @Override
    public void configure(PluginContext context) {
        super.configure(context);
        context.registerSystemPrompt("mysql-capabilities", 20, """
                ## DSH MySQL Plugin
                - 所有 MySQL 工具均为只读，禁止生成/执行 UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE。
                - connectionId 一般由对话上下文直接给出；仅在未知时才调用 mysql_list_connections 获取。
                - 回答表结构、数据内容、行数等问题前，必须先用 mysql_read_query 查证真实结果，禁止凭空猜测。
                - 评估 SQL 性能前先调用 mysql_explain_query 查看执行计划。
                - 诊断连接数、慢查询、锁等待问题时调用 mysql_performance_snapshot。
                - 给出可能修改数据的 SQL 前，先调用 mysql_sql_review 做风险审计，并提示用户在页面手动执行。
                """);
        context.registerHook("PRE_TOOL_USE", (toolName, payloadJson) -> {
            if (toolName != null && toolName.startsWith("plugin__" + PLUGIN_ID + "__mysql_")) {
                return PluginHookResult.context("DSH MySQL audit: read-only tool call.");
            }
            return null;
        });
    }

    private String get(String path, Map<String, Object> args) {
        String adminUrl = baseUrl(args);
        return send(HttpRequest.newBuilder(URI.create(adminUrl + path)).GET().build());
    }

    private String post(String path, String json, Map<String, Object> args) {
        String adminUrl = baseUrl(args);
        return send(HttpRequest.newBuilder(URI.create(adminUrl + path))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json))
                .build());
    }

    private String baseUrl(Map<String, Object> args) {
        Object override = args == null ? null : args.get("adminBaseUrl");
        return override == null || String.valueOf(override).isBlank()
                ? System.getenv().getOrDefault("DSH_MYSQL_ADMIN_URL", "http://127.0.0.1:8091")
                : String.valueOf(override);
    }

    private String send(HttpRequest request) {
        try {
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() / 100 != 2) {
                return failJson(response.statusCode(), response.body());
            }
            return response.body();
        } catch (Exception e) {
            return failJson(0, e.getMessage());
        }
    }

    private String failJson(int status, String message) {
        return "{\"error\":true,\"status\":" + status + ",\"message\":\"" + json(message) + "\"}";
    }

    private String json(String value) {
        if (value == null) return "";
        return value.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
    }

    private String sqlJson(Map<String, Object> args, String key) {
        return "{\"sql\":\"" + json(str(args, key)) + "\"}";
    }

    private String str(Map<String, Object> args, String key) {
        Object value = args == null ? null : args.get(key);
        return value == null ? "" : String.valueOf(value);
    }

    private class ListConnectionsTool extends AbstractTool {
        @Override public String name() { return "mysql_list_connections"; }
        @Override public String description() { return "列出 DSH MySQL 管理后台中已配置的数据库连接，返回连接 id、名称、主机等。仅在不知道 connectionId 时调用；若对话上下文已提供连接 ID，直接使用即可，无需调用本工具。"; }
        @Override public Map<String, Object> parameters() {
            return objectSchema()
                    .prop("adminBaseUrl", stringSchema("可选，DSH 管理后台地址，默认 http://127.0.0.1:8091"))
                    .build();
        }
        @Override public boolean isConcurrencySafe(Object args) { return true; }
        @Override protected java.util.concurrent.CompletableFuture<cn.xiaofuge.deepseek.harness.domain.model.entity.ToolExecutionResult>
        run(Map<String, Object> args, cn.xiaofuge.deepseek.harness.domain.model.entity.ToolRunContext ctx) {
            return ok(get("/api/connections", args));
        }
    }

    private class ReadQueryTool extends AbstractTool {
        @Override public String name() { return "mysql_read_query"; }
        @Override public String description() { return "在指定连接上执行只读 MySQL 查询（SELECT/SHOW/DESC），返回真实查询结果 JSON，最多返回后台配置行数。涉及表结构、数据内容、行数统计时必须调用本工具查证，禁止编造结果。写操作（INSERT/UPDATE/DELETE/DDL）会被拒绝。"; }
        @Override public Map<String, Object> parameters() {
            return objectSchema()
                    .prop("connectionId", stringSchema("DSH 连接 ID，通常由对话上下文中的「当前 MySQL 连接 ID」给出"))
                    .prop("sql", stringSchema("只读 SQL，例如 SELECT ... LIMIT 100、SHOW TABLES、DESC table_name；尽量加 LIMIT 避免大结果集"))
                    .prop("adminBaseUrl", stringSchema("可选，DSH 管理后台地址，默认 http://127.0.0.1:8091"))
                    .required("connectionId", "sql")
                    .build();
        }
        @Override public boolean isConcurrencySafe(Object args) { return true; }
        @Override protected java.util.concurrent.CompletableFuture<cn.xiaofuge.deepseek.harness.domain.model.entity.ToolExecutionResult>
        run(Map<String, Object> args, cn.xiaofuge.deepseek.harness.domain.model.entity.ToolRunContext ctx) {
            String connectionId = json(str(args, "connectionId"));
            return ok(post("/api/mysql/" + connectionId + "/query", sqlJson(args, "sql"), args));
        }
    }

    private class ExplainQueryTool extends AbstractTool {
        @Override public String name() { return "mysql_explain_query"; }
        @Override public String description() { return "对指定 SELECT/SHOW SQL 执行 MySQL EXPLAIN，返回执行计划（type、key、rows 等）。在评估或优化 SQL 性能、判断是否走索引时必须先调用本工具。"; }
        @Override public Map<String, Object> parameters() {
            return objectSchema()
                    .prop("connectionId", stringSchema("DSH 连接 ID，通常由对话上下文中的「当前 MySQL 连接 ID」给出"))
                    .prop("sql", stringSchema("待分析的 SELECT 或 SHOW SQL"))
                    .prop("adminBaseUrl", stringSchema("可选，DSH 管理后台地址，默认 http://127.0.0.1:8091"))
                    .required("connectionId", "sql")
                    .build();
        }
        @Override public boolean isConcurrencySafe(Object args) { return true; }
        @Override protected java.util.concurrent.CompletableFuture<cn.xiaofuge.deepseek.harness.domain.model.entity.ToolExecutionResult>
        run(Map<String, Object> args, cn.xiaofuge.deepseek.harness.domain.model.entity.ToolRunContext ctx) {
            String connectionId = json(str(args, "connectionId"));
            return ok(post("/api/mysql/" + connectionId + "/explain", sqlJson(args, "sql"), args));
        }
    }

    private class PerformanceTool extends AbstractTool {
        @Override public String name() { return "mysql_performance_snapshot"; }
        @Override public String description() { return "获取 MySQL 实例性能快照：连接数、慢查询数、锁等待、临时表、当前进程列表等。用于诊断慢查询、连接打满、锁等待等运行时问题。"; }
        @Override public Map<String, Object> parameters() {
            return objectSchema()
                    .prop("connectionId", stringSchema("DSH 连接 ID，通常由对话上下文中的「当前 MySQL 连接 ID」给出"))
                    .prop("adminBaseUrl", stringSchema("可选，DSH 管理后台地址，默认 http://127.0.0.1:8091"))
                    .required("connectionId")
                    .build();
        }
        @Override public boolean isConcurrencySafe(Object args) { return true; }
        @Override protected java.util.concurrent.CompletableFuture<cn.xiaofuge.deepseek.harness.domain.model.entity.ToolExecutionResult>
        run(Map<String, Object> args, cn.xiaofuge.deepseek.harness.domain.model.entity.ToolRunContext ctx) {
            return ok(get("/api/mysql/" + json(str(args, "connectionId")) + "/performance", args));
        }
    }

    private class SqlReviewTool extends AbstractTool {
        @Override public String name() { return "mysql_sql_review"; }
        @Override public String description() { return "基于本地规则静态检查 SQL 是否包含 DROP/UPDATE/DELETE/ALTER/TRUNCATE 等危险写操作，仅返回审计建议，不连接数据库。在向用户给出可能修改数据的 SQL 前先调用本工具。"; }
        @Override public Map<String, Object> parameters() {
            return objectSchema().prop("sql", stringSchema("待检查 SQL")).required("sql").build();
        }
        @Override public boolean isConcurrencySafe(Object args) { return true; }
        @Override protected java.util.concurrent.CompletableFuture<cn.xiaofuge.deepseek.harness.domain.model.entity.ToolExecutionResult>
        run(Map<String, Object> args, cn.xiaofuge.deepseek.harness.domain.model.entity.ToolRunContext ctx) {
            String sql = str(args, "sql").toLowerCase();
            boolean dangerous = sql.matches("(?s).*(drop|truncate|delete|update|alter)\\s.*");
            return ok("{\"dangerous\":" + dangerous + ",\"advice\":\"" + (dangerous
                    ? "包含潜在破坏性操作，请在人工审批后执行。"
                    : "未发现高危写关键字，仍建议先 EXPLAIN。") + "\"}");
        }
    }
}
