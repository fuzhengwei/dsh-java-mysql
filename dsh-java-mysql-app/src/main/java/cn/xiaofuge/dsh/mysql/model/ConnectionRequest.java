package cn.xiaofuge.dsh.mysql.model;

import jakarta.validation.constraints.NotBlank;

public record ConnectionRequest(
        String id,
        @NotBlank String name,
        @NotBlank String host,
        Integer port,
        @NotBlank String database,
        @NotBlank String username,
        String password
) {
}
