package cn.xiaofuge.dsh.mysql.service;

import cn.xiaofuge.dsh.mysql.config.MySqlAdminProperties;
import cn.xiaofuge.dsh.mysql.model.ApiException;
import cn.xiaofuge.dsh.mysql.model.QueryResult;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class QueryService {
    private final MySqlAdminProperties properties;
    private final ConnectionStore connectionStore;
    private final Map<String, Connection> connections = new ConcurrentHashMap<>();

    public QueryService(MySqlAdminProperties properties, ConnectionStore connectionStore) {
        this.properties = properties;
        this.connectionStore = connectionStore;
    }

    public synchronized QueryResult execute(String connectionId, String sql, boolean allowWrite) {
        List<String> statements = splitStatements(sql);
        if (statements.isEmpty()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "SQL 不能为空");
        }
        boolean readOnly = statements.stream().allMatch(this::isReadOnly);
        if (!readOnly && !allowWrite) {
            throw new ApiException(HttpStatus.FORBIDDEN, "检测到写操作，请在界面上明确确认后执行");
        }
        try {
            Connection connection = connection(connectionId);
            long started = System.nanoTime();
            int affectedRows = 0;
            QueryResult last = QueryResult.empty(statements.get(statements.size() - 1), readOnly, 0, 0);
            connection.setAutoCommit(!allowWrite);
            for (String statement : statements) {
                try (Statement jdbcStatement = connection.createStatement()) {
                    jdbcStatement.setQueryTimeout(properties.queryTimeoutSeconds());
                    jdbcStatement.setMaxRows(readOnly ? properties.maxRows() : 0);
                    boolean hasResultSet = jdbcStatement.execute(statement);
                    if (hasResultSet) {
                        last = readResultSet(statement, readOnly, jdbcStatement.getResultSet());
                    } else {
                        affectedRows += jdbcStatement.getUpdateCount();
                        last = QueryResult.empty(statement, readOnly, elapsed(started), affectedRows);
                    }
                }
            }
            if (allowWrite) {
                connection.commit();
            }
            return new QueryResult(last.columns(), last.rows(), affectedRows,
                    elapsed(started), readOnly, sql);
        } catch (SQLException e) {
            throw new ApiException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
    }

    public Map<String, Object> overview(String connectionId) {
        try {
            Connection connection = connection(connectionId);
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("database", connection.getCatalog());
            result.put("product", connection.getMetaData().getDatabaseProductName());
            result.put("version", connection.getMetaData().getDatabaseProductVersion());
            result.put("url", connection.getMetaData().getURL());
            return result;
        } catch (SQLException e) {
            throw new ApiException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
    }

    public List<Map<String, Object>> tables(String connectionId, String database) {
        try {
            Connection connection = connection(connectionId);
            String schema = database == null || database.isBlank()
                    ? connection.getCatalog()
                    : safeIdentifier(database);
            return toMaps("""
                    SELECT TABLE_NAME AS name, TABLE_TYPE AS type,
                           IFNULL(TABLE_COMMENT, '') AS remarks
                    FROM information_schema.TABLES
                    WHERE TABLE_SCHEMA = '%s'
                    ORDER BY TABLE_NAME
                    """.formatted(schema), connection);
        } catch (SQLException e) {
            throw new ApiException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
    }

    public Map<String, Object> tableDetail(String connectionId, String table) {
        try {
            Connection connection = connection(connectionId);
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("columns", toMaps("SHOW FULL COLUMNS FROM `" + safeIdentifier(table) + "`", connection));
            result.put("indexes", toMaps("SHOW INDEX FROM `" + safeIdentifier(table) + "`", connection));
            result.put("ddl", toMaps("SHOW CREATE TABLE `" + safeIdentifier(table) + "`", connection));
            return result;
        } catch (SQLException e) {
            throw new ApiException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
    }

    public Map<String, Object> performance(String connectionId) {
        try {
            Connection connection = connection(connectionId);
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("processes", toMaps("SHOW FULL PROCESSLIST", connection));
            result.put("status", toMaps("""
                    SHOW GLOBAL STATUS WHERE Variable_name IN
                    ('Threads_connected','Threads_running','Questions','Slow_queries','Innodb_row_lock_waits',
                     'Innodb_row_lock_time','Created_tmp_disk_tables','Select_full_join')
                    """, connection));
            result.put("variables", toMaps("""
                    SHOW GLOBAL VARIABLES WHERE Variable_name IN
                    ('max_connections','innodb_buffer_pool_size','sort_buffer_size','tmp_table_size',
                     'long_query_time','innodb_flush_log_at_trx_commit')
                    """, connection));
            return result;
        } catch (SQLException e) {
            throw new ApiException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
    }

    public QueryResult explain(String connectionId, String sql) {
        String clean = stripTrailingSemicolon(sql.trim());
        if (!isReadOnly(clean)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "EXPLAIN 只支持 SELECT/SHOW/DESC 语句");
        }
        try {
            Connection connection = connection(connectionId);
            long started = System.nanoTime();
            try (Statement statement = connection.createStatement();
                 ResultSet rows = statement.executeQuery("EXPLAIN " + clean)) {
                return readResultSet("EXPLAIN " + clean, true, rows);
            }
        } catch (SQLException e) {
            throw new ApiException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
    }

    public void test(String connectionId) {
        try (Connection ignored = DriverManager.getConnection(
                jdbcArguments(connectionId).get("url"),
                jdbcArguments(connectionId).get("username"),
                jdbcArguments(connectionId).get("password"))) {
        } catch (SQLException e) {
            throw new ApiException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
    }

    public Map<String, String> jdbcArguments(String connectionId) {
        return connectionStore.jdbcArguments(connectionId);
    }

    private Connection connection(String connectionId) throws SQLException {
        Connection existing = connections.get(connectionId);
        if (existing != null && !existing.isClosed()) {
            return existing;
        }
        Map<String, String> arguments = connectionStore.jdbcArguments(connectionId);
        Connection connection = DriverManager.getConnection(arguments.get("url"),
                arguments.get("username"), arguments.get("password"));
        Connection previous = connections.put(connectionId, connection);
        if (previous != null) {
            closeQuietly(previous);
        }
        return connection;
    }

    private QueryResult readResultSet(String sql, boolean readOnly, ResultSet rows) throws SQLException {
        ResultSetMetaData metadata = rows.getMetaData();
        List<String> columns = new ArrayList<>();
        for (int index = 1; index <= metadata.getColumnCount(); index++) {
            columns.add(metadata.getColumnLabel(index));
        }
        List<Map<String, Object>> values = new ArrayList<>();
        while (rows.next() && values.size() < properties.maxRows()) {
            Map<String, Object> row = new LinkedHashMap<>();
            for (int index = 1; index <= metadata.getColumnCount(); index++) {
                row.put(columns.get(index - 1), rows.getObject(index));
            }
            values.add(row);
        }
        return new QueryResult(columns, values, 0, 0, readOnly, sql);
    }

    private List<Map<String, Object>> toMaps(String sql, Connection connection) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            return readResultSet(sql, true, rows).rows();
        }
    }

    private boolean isReadOnly(String sql) {
        String normalized = stripLeadingComments(sql).toLowerCase(Locale.ROOT);
        return normalized.startsWith("select") || normalized.startsWith("show")
                || normalized.startsWith("desc") || normalized.startsWith("describe")
                || normalized.startsWith("explain");
    }

    private String stripLeadingComments(String sql) {
        String value = sql.trim();
        while (value.startsWith("/*")) {
            int end = value.indexOf("*/");
            if (end < 0) {
                break;
            }
            value = value.substring(end + 2).trim();
        }
        while (value.startsWith("--")) {
            int end = value.indexOf('\n');
            if (end < 0) {
                break;
            }
            value = value.substring(end + 1).trim();
        }
        return value;
    }

    private String stripTrailingSemicolon(String sql) {
        return sql.endsWith(";") ? sql.substring(0, sql.length() - 1) : sql;
    }

    private List<String> splitStatements(String sql) {
        List<String> statements = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        char quote = 0;
        for (int index = 0; index < sql.length(); index++) {
            char character = sql.charAt(index);
            current.append(character);
            if (quote != 0) {
                if (character == quote) {
                    quote = 0;
                }
                continue;
            }
            if (character == '\'' || character == '"' || character == '`') {
                quote = character;
            } else if (character == ';') {
                addStatement(statements, current);
            }
        }
        addStatement(statements, current);
        return statements;
    }

    private void addStatement(List<String> statements, StringBuilder current) {
        String statement = stripTrailingSemicolon(current.toString().trim());
        current.setLength(0);
        if (!statement.isBlank()) {
            statements.add(statement);
        }
    }

    private String safeIdentifier(String value) {
        if (!value.matches("[A-Za-z0-9_$]+")) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "非法表名");
        }
        return value;
    }

    private long elapsed(long started) {
        return (System.nanoTime() - started) / 1_000_000;
    }

    private void closeQuietly(Connection connection) {
        try {
            connection.close();
        } catch (SQLException ignored) {
        }
    }
}
