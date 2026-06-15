# Pi Workflow Tracker

Workflow tracker này dùng để hiển thị workflow hiện tại ở footer của PI TUI.

## Files
- `feature-standard.json`: workflow đầy đủ cho feature flow
- `.active-workflow.json`: state workflow đang active trong session hiện tại

## Commands
- `/workflows` — liệt kê workflow
- `/workflows current` — xem workflow active, step hiện tại, step tiếp theo, hint tiếp theo
- `/workflows view <workflow-id>` — xem toàn bộ step của workflow
- `/workflows use <workflow-id>` — kích hoạt workflow và hiển thị ở footer
- `/workflows next` — chuyển sang step tiếp theo
- `/workflows prev` — lùi về step trước
- `/workflows set <step-id|step-number>` — nhảy đến step cụ thể
- `/workflows clear` — clear workflow active khỏi footer

## Footer UI
Footer hiển thị theo dạng compact:

```text
↪ Workflow: Feature Standard · 3/8 · Create plan → Review plan (/review-plan)
```

## Workflow JSON shape
Mỗi step nên có tối thiểu:

```json
{
  "id": "create-plan",
  "title": "Create plan",
  "type": "command",
  "value": "/create-plan",
  "hint": "Gõ /create-plan @docs/ai/specs/<file>.md"
}
```

`type`, `value`, `hint` chủ yếu dùng để hiển thị trên TUI.
