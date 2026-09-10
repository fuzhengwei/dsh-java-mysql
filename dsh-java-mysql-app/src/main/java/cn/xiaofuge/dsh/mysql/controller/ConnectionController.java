package cn.xiaofuge.dsh.mysql.controller;

import cn.xiaofuge.dsh.mysql.model.ConnectionRequest;
import cn.xiaofuge.dsh.mysql.model.ConnectionResponse;
import cn.xiaofuge.dsh.mysql.service.ConnectionStore;
import cn.xiaofuge.dsh.mysql.service.QueryService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/connections")
public class ConnectionController {
    private final ConnectionStore connectionStore;
    private final QueryService queryService;

    public ConnectionController(ConnectionStore connectionStore, QueryService queryService) {
        this.connectionStore = connectionStore;
        this.queryService = queryService;
    }

    @GetMapping
    public List<ConnectionResponse> list() {
        return connectionStore.list();
    }

    @PostMapping
    public ConnectionResponse save(@Valid @RequestBody ConnectionRequest request) {
        ConnectionResponse response = connectionStore.save(request);
        queryService.test(response.id());
        return response;
    }

    @PostMapping("/{id}/test")
    public Map<String, Object> test(@PathVariable("id") String id) {
        queryService.test(id);
        return Map.of("ok", true);
    }

    @DeleteMapping("/{id}")
    public void delete(@PathVariable("id") String id) {
        connectionStore.delete(id);
    }
}
