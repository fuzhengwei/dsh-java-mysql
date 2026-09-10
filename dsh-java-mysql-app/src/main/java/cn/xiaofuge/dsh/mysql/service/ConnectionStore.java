package cn.xiaofuge.dsh.mysql.service;

import cn.xiaofuge.dsh.mysql.config.MySqlAdminProperties;
import cn.xiaofuge.dsh.mysql.model.ConnectionRequest;
import cn.xiaofuge.dsh.mysql.model.ConnectionResponse;
import cn.xiaofuge.dsh.mysql.model.ApiException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Service
public class ConnectionStore {
    private static final int GCM_TAG_BITS = 128;
    private static final int GCM_IV_BYTES = 12;
    private static final String CIPHER = "AES/GCM/NoPadding";

    private final MySqlAdminProperties properties;
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final SecureRandom random = new SecureRandom();
    private final SecretKey key;
    private final Map<String, Map<String, Object>> profiles = new LinkedHashMap<>();

    public ConnectionStore(MySqlAdminProperties properties) throws Exception {
        this.properties = properties;
        this.key = loadOrCreateKey();
        load();
    }

    public List<ConnectionResponse> list() {
        return profiles.values().stream().map(this::toResponse).toList();
    }

    public ConnectionResponse save(ConnectionRequest request) {
        String id = request.id() == null || request.id().isBlank() ? UUID.randomUUID().toString() : request.id();
        Map<String, Object> profile = profiles.get(id);
        if (profile == null) {
            profile = new LinkedHashMap<>();
            profile.put("id", id);
        }
        profile.put("name", request.name());
        profile.put("host", request.host());
        profile.put("port", request.port() == null ? 3306 : request.port());
        profile.put("database", request.database());
        profile.put("username", request.username());
        if (request.password() != null && !request.password().isBlank()) {
            profile.put("password", encrypt(request.password()));
        }
        profiles.put(id, profile);
        persist();
        return toResponse(profile);
    }

    public void delete(String id) {
        if (profiles.remove(id) == null) {
            throw new ApiException(HttpStatus.NOT_FOUND, "连接不存在");
        }
        persist();
    }

    public Map<String, String> jdbcArguments(String id) {
        Map<String, Object> profile = profiles.get(id);
        if (profile == null) {
            throw new ApiException(HttpStatus.NOT_FOUND, "连接不存在");
        }
        String host = text(profile, "host");
        int port = ((Number) profile.getOrDefault("port", 3306)).intValue();
        String database = text(profile, "database");
        String url = "jdbc:mysql://%s:%d/%s?useSSL=false&allowPublicKeyRetrieval=true&serverTimezone=Asia/Shanghai&useUnicode=true&characterEncoding=utf8"
                .formatted(host, port, database);
        return Map.of("url", url, "username", text(profile, "username"), "password", decrypt(text(profile, "password")));
    }

    private ConnectionResponse toResponse(Map<String, Object> profile) {
        return new ConnectionResponse(
                text(profile, "id"),
                text(profile, "name"),
                text(profile, "host"),
                ((Number) profile.getOrDefault("port", 3306)).intValue(),
                text(profile, "database"),
                text(profile, "username"),
                profile.containsKey("password"));
    }

    private String text(Map<String, Object> map, String key) {
        Object value = map.get(key);
        return value == null ? "" : String.valueOf(value);
    }

    private void persist() {
        try {
            Path file = file();
            Files.createDirectories(file.getParent());
            objectMapper.writerWithDefaultPrettyPrinter().writeValue(file.toFile(), profiles.values());
        } catch (IOException e) {
            throw new IllegalStateException("无法保存连接配置", e);
        }
    }

    private void load() throws IOException {
        Path file = file();
        if (!Files.exists(file)) {
            return;
        }
        List<Map<String, Object>> values = objectMapper.readValue(file.toFile(),
                new TypeReference<List<Map<String, Object>>>() {
                });
        values.forEach(profile -> profiles.put(String.valueOf(profile.get("id")), profile));
    }

    private Path file() {
        return Path.of(properties.dataDirectory(), "connections.json");
    }

    private SecretKey loadOrCreateKey() throws Exception {
        Path keyFile = Path.of(properties.dataDirectory(), "secret.key");
        if (Files.exists(keyFile)) {
            byte[] encoded = Base64.getDecoder().decode(Files.readString(keyFile).trim());
            return new SecretKeySpec(encoded, "AES");
        }
        KeyGenerator generator = KeyGenerator.getInstance("AES");
        generator.init(256);
        SecretKey secretKey = generator.generateKey();
        Files.createDirectories(keyFile.getParent());
        Files.writeString(keyFile, Base64.getEncoder().encodeToString(secretKey.getEncoded()));
        return secretKey;
    }

    private String encrypt(String value) {
        try {
            byte[] iv = new byte[GCM_IV_BYTES];
            random.nextBytes(iv);
            Cipher cipher = Cipher.getInstance(CIPHER);
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
            byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder().encodeToString(iv) + ":" + Base64.getEncoder().encodeToString(encrypted);
        } catch (Exception e) {
            throw new IllegalStateException("加密连接密码失败", e);
        }
    }

    private String decrypt(String value) {
        try {
            String[] parts = value.split(":", 2);
            Cipher cipher = Cipher.getInstance(CIPHER);
            cipher.init(Cipher.DECRYPT_MODE, key,
                    new GCMParameterSpec(GCM_TAG_BITS, Base64.getDecoder().decode(parts[0])));
            return new String(cipher.doFinal(Base64.getDecoder().decode(parts[1])), StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new IllegalStateException("解密连接密码失败", e);
        }
    }
}
