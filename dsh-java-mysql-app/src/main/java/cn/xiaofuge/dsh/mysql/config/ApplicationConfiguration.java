package cn.xiaofuge.dsh.mysql.config;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@Configuration
@EnableConfigurationProperties(MySqlAdminProperties.class)
public class ApplicationConfiguration {
}
