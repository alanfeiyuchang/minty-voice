@echo off
rem 把你自己的动画做成形象包：tools\make-avatar.cmd <素材文件夹> --name "我的狗"
chcp 65001 >nul
where uv >nul 2>nul && (set "UV=uv") || (set "UV=%USERPROFILE%\.local\bin\uv.exe")
"%UV%" run --quiet --with "pillow>=11.3" --with numpy --with opencv-python-headless "%~dp0make-avatar.py" %*
