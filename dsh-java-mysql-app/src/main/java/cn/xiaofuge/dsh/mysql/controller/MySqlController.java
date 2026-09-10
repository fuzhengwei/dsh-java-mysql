package cn.xiaofuge.dsh.mysql.controller;

import cn.xiaofuge.dsh.mysql.model.QueryRequest;
import cn.xiaofuge.dsh.mysql.model.QueryResult;
import cn.xiaofuge.dsh.mysql.model.ApiException;
import cn.xiaofuge.dsh.mysql.service.HarnessAiService;
import cn.xiaofuge.dsh.mysql.service.HarnessAiStreamService;
import cn.xiaofuge.dsh.mysql.service.QueryService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/mysql")
public class MySqlController {
    private final QueryService queryService;
    private final HarnessAiService harnessAiService;
    private final HarnessAiStreamService harnessAiStreamService;

    public MySqlController(QueryService queryService,
                           HarnessAiService harnessAiService,
                           HarnessAiStreamService harnessAiStreamService) {
        this.queryService = queryService;
        this.harnessAiService = harnessAiService;
        this.harnessAiStreamService = harnessAiStreamService;
    }

    @GetMapping("/{connectionId}/overview")
    public Map<String, Object> overview(@PathVariable("connectionId") String connectionId) {
        return queryService.overview(connectionId);
    }

    @GetMapping("/{connectionId}/tables")
    public List<Map<String, Object>> tables(@PathVariable("connectionId") String connectionId,
                                            @RequestParam(required = false) String database) {
        return queryService.tables(connectionId, database);
    }

    @GetMapping("/{connectionId}/tables/{table}")
    public Map<String, Object> table(@PathVariable("connectionId") String connectionId,
                                     @PathVariable("table") String table) {
        return queryService.tableDetail(connectionId, table);
    }

    @PostMapping("/{connectionId}/query")
    public QueryResult query(@PathVariable("connectionId") String connectionId,
                             @Valid @RequestBody QueryRequest request) {
        return queryService.execute(connectionId, request.sql(), request.allowWrite());
    }

    @PostMapping("/{connectionId}/explain")
    public QueryResult explain(@PathVariable("connectionId") String connectionId,
                               @RequestBody QueryRequest request) {
        return queryService.explain(connectionId, request.sql());
    }

    @GetMapping("/{connectionId}/performance")
    public Map<String, Object> performance(@PathVariable("connectionId") String connectionId) {
        return queryService.performance(connectionId);
    }

    @PostMapping("/{connectionId}/ai")
    public Map<String, Object> ai(@PathVariable("connectionId") String connectionId,
                                  @RequestBody Map<String, String> request) {
        String agentId = request.getOrDefault("agentId", "");
        String message = request.getOrDefault("message", "");
        String table = request.getOrDefault("table", "");
        if (agentId.isBlank()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "agentId 不能为空");
        }
        if (message.isBlank()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "message 不能为空");
        }
        return Map.of("answer", harnessAiService.chat(agentId, buildPrompt(connectionId, table, message)));
    }

    @PostMapping(value = "/{connectionId}/ai/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(@PathVariable("connectionId") String connectionId,
                             @RequestBody Map<String, String> request) {
        String agentId = request.getOrDefault("agentId", "");
        String message = request.getOrDefault("message", "");
        String table = request.getOrDefault("table", "");
        if (agentId.isBlank()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "agentId 不能为空");
        }
        if (message.isBlank()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "message 不能为空");
        }
        return harnessAiStreamService.stream(agentId, buildPrompt(connectionId, table, message));
    }
    /**
     * 组装发往 Harness Agent 的用户消息。
     * <p>连接上下文随消息携带；工具能力已在 Harness 侧以
     * plugin__dsh-java-mysql-plugin__mysql_* 形式注册，这里明确告知模型
     * 优先调用工具查证真实数据，避免凭空生成 SQL。</p>
     */
    private String buildPrompt(String connectionId, String table, String message) {
        StringBuilder prompt = new StringBuilder();
        prompt.append("当前环境：\n");
        prompt.append("- MySQL 连接 ID：").append(connectionId).append("\n");
        if (!table.isBlank()) {
            prompt.append("- 当前选中表：").append(table).append("\n");
        }
        prompt.append("- 你可以使用以下只读 MySQL 工具获取真实数据（回答涉及表结构、数据内容、行数、性能的问题时，必须先调用工具查证，禁止凭空猜测）：\n");
        prompt.append("  - plugin__dsh-java-mysql-plugin__mysql_read_query(connectionId, sql)：执行只读 SELECT/SHOW/DESC\n");
        prompt.append("  - plugin__dsh-java-mysql-plugin__mysql_explain_query(connectionId, sql)：查看执行计划\n");
        prompt.append("  - plugin__dsh-java-mysql-plugin__mysql_performance_snapshot(connectionId)：性能与进程快照\n");
        prompt.append("  - plugin__dsh-java-mysql-plugin__mysql_sql_review(sql)：SQL 风险审计\n");
        prompt.append("\n用户需求：").append(message);
        prompt.append("\n\n回答要求：\n");
        prompt.append("- 使用中文，Markdown 格式，结论先行。\n");
        prompt.append("- 需要用户手动执行的 SQL 放在 ```sql 代码块中（页面提供执行按钮），并注明是否为写操作；写操作必须先说明风险。\n");
        prompt.append("- 引用工具查询结果时给出关键数字与结论，不要原样转储大段 JSON。\n");
        return prompt.toString();
    }
}
