# 开发笔记（不进打包）

## 发布

仓库根目录既是插件也是 marketplace（`.claude-plugin/marketplace.json` 的 source 是 `./`），别人 clone 下来运行
`./setup.sh`：有 `claude` 命令时 `claude plugin marketplace add <clone 目录>` + `claude plugin install minty@minty`
（读的就是 clone 出来的文件夹）；只有桌面版时写进 `~/.claude/settings.json` 的 `CLAUDE_CODE_PLUGIN_DIRS`。

```bash
./scripts/package.sh   # → dist/minty-voice-<版本>.zip（提交过的文件，git archive），可以传到 GitHub Releases
```

版本号在 `.claude-plugin/plugin.json`（marketplace.json 里的跟着改）。发版前：`claude plugin validate .`、`claude plugin test .`。

这台机器是从这个目录加载的（settings.json 的 `CLAUDE_CODE_PLUGIN_DIRS`），别再装一份，不然会加载两遍。

## 自带的猫是怎么做的

1. `pet/photos/` 放猫的照片，`pet/refs/` 是裁到只剩猫的版本（参考图背景越干净，生成的背景越干净）
2. 在一台有 GPU 的机器上用本地 ComfyUI（`~/ComfyUI`，端口 8188）的 MiniMax H3 reference-to-video 生成：`python3 pet/gen_pet.py <状态> --full`
   （参考图先上传成 ComfyUI input 里的 `minty_ref{1,2,3}.jpg`；20 步约 55 秒一个状态，纯色蓝幕、3 秒）
3. 把 `~/ComfyUI/output/minty_pet/<状态>_full_*.png` 拷到 `pet/frames/<状态>/`
4. `./tools/make-avatar.sh pet/frames --name 猫 --id cat --out avatars`

`pet/make_sprites.py` 是 make-avatar 的前身，留着做参考。
