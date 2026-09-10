package cn.xiaofuge.dsh.mysql.service;

import cn.xiaofuge.dsh.mysql.config.MySqlAdminProperties;
import cn.xiaofuge.dsh.mysql.model.ApiException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

import java.util.List;
import java.util.Map;

@Service
public class AiAssistantService {
    private final MySqlAdminProperties properties;
    private final RestClient restClient;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public AiAssistantService(MySqlAdminProperties properties, RestClient.Builder builder) {
        this.properties = properties;
        this.restClient = builder.baseUrl(properties.ai().baseUrl()).build();
    }

    public Map<String, Object> advice(String sql, String schemaContext, String question) {
        if (properties.ai().apiKey() == null || properties.ai().apiKey().isBlank()) {
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE,
                    "未配置 DSH_AI_API_KEY，无法启用云端 AI 助手");
        }
        String systemPrompt = """
                你是资深 MySQL DBA。用户提供 MySQL 表结构和 SQL。
                请用简体中文回答：1) SQL 是否正确；2) 性能与索引建议；3) 风险和事务注意事项。
                不要编造表结构。若信息不足，先列出需要补充的信息。回答控制在 300 字内。
                """;
        Map<String, Object> request = Map.of(
                "model", properties.ai().model(),
                "messages", List.of(
                        Map.of("role", "system", "content", systemPrompt),
                        Map.of("role", "user", "content",
                                "表结构：\n" + schemaContext + "\n\n问题：" + question + "\n\nSQL：\n" + sql)),
                "temperature", 0.2
        );
        try {
            String response = restClient.post()
                    .uri("/chat/completions")
                    .header("Authorization", "Bearer " + properties.ai().apiKey())
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(request)
                    .retrieve()
                    .body(String.class);
            JsonNode root = objectMapper.readTree(response == null ? "{}" : response);
            String answer = root.path("choices").path(0).path("message").path("content").asText("AI 未返回内容");
            return Map.of("answer", answer);
        } catch (Exception e) {
            throw new ApiException(HttpStatus.BAD_GATEWAY, "AI 调用失败：" + e.getMessage());
        }
    }
}
