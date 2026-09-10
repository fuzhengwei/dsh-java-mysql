package cn.xiaofuge.dsh.mysql.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "dsh.mysql")
public record MySqlAdminProperties(
        String dataDirectory,
        int queryTimeoutSeconds,
        int maxRows,
        Harness harness,
        Ai ai
) {
    public record Harness(String baseUrl) {
    }

    public record Ai(String baseUrl, String apiKey, String model) {
    }
}
