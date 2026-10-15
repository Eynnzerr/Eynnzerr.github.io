---
title: 'Activity Result API：把启动请求与结果处理写成合约'
description: '从类型化输入输出到生命周期注册，串起内置 Contract、自定义城市选择器和 Compose 用法，厘清重建后结果恢复与 Uri 授权的职责。'
date: '2026-03-12T16:20:07+08:00'
categories: [Android, Jetpack]
tags: [Android, ActivityResult, Jetpack Compose, Kotlin]
updated: '2026-10-15'
---

旧的 Activity 结果处理方式把许多请求集中到一个 `onActivityResult()` 中：先判断 `requestCode`，再判断结果码，最后从 `Intent` 中取数据。请求越多，入口和结果分支越难对应。

Activity Result API 把这件事拆成三个角色：**Contract 定义输入输出，Launcher 发起请求，Callback 接收结果**。它仍然通过 Android 的组件与结果机制工作，但调用方可以围绕一个明确的操作编程。

## 一次请求的完整路径

```text
注册 Contract 与 Callback
          ↓
获得 ActivityResultLauncher<I>
          ↓
用户操作 → launch(input)
          ↓
Contract 构造 Intent，目标组件完成任务
          ↓
Contract 解析 resultCode 与 Intent
          ↓
Callback 接收 O
```

例如 `GetContent` 的输入是 MIME 类型字符串，输出是 `Uri?`；选择结果为 `null` 时，表示没有获得内容。调用方无需再自行约定一个“选图片”的请求码。

```kotlin
import android.net.Uri
import android.os.Bundle
import android.widget.Button
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

/** Let the user select one image through a registered result contract. */
class ImagePickerActivity : ComponentActivity() {
    /** Keep registration unconditional and in a stable order across recreation. */
    private val pickImage = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        if (uri != null) {
            Toast.makeText(this, "已选择：$uri", Toast.LENGTH_SHORT).show()
        }
    }

    /** Build the UI after the launcher has been registered. */
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(Button(this).apply {
            text = "选择图片"
            setOnClickListener { pickImage.launch("image/*") }
        })
    }
}
```

这个例子展示 `GetContent` 的类型关系。面向照片和视频选择的新功能，也可以直接采用系统 Photo Picker 对应的 `PickVisualMedia` 合约。

## 注册与启动是两个不同的时机

结果可能在 Activity 或进程重建后才返回，因此注册回调必须在每次创建时无条件完成。多个 Launcher 的注册顺序也应保持一致，使正在返回的结果仍能匹配原来的回调。

实际代码可以像上例一样在成员初始化时注册。不要等用户点击后才注册；点击回调只负责调用已经存在的 Launcher。绑定 Lifecycle 的注册发生在进入 `STARTED` 之前，而 Launcher 发起请求至少要等宿主达到 `CREATED`。[获取 Activity 结果](https://developer.android.com/training/basics/intents/result)

框架恢复的是请求与回调之间的对应关系。处理结果所需的业务状态，例如当前正在编辑的订单 ID，仍应使用自己的状态保存机制恢复。把 ID 只放在旧 Activity 的普通字段里，重建后回调即使成功抵达，也可能失去正确的业务上下文。

## 先选内置 Contract

| 场景 | Contract | 输入 → 输出 |
| --- | --- | --- |
| 通用 Activity 结果 | `StartActivityForResult` | `Intent` → `ActivityResult` |
| 单个权限 | `RequestPermission` | 权限名 → `Boolean` |
| 多个权限 | `RequestMultiplePermissions` | 权限数组 → 授权结果 Map |
| 拍摄缩略图 | `TakePicturePreview` | `null` → `Bitmap?` |
| 拍照写入指定位置 | `TakePicture` | `Uri` → `Boolean` |
| 录像写入指定位置 | `CaptureVideo` | `Uri` → `Boolean` |
| 选择图片或视频 | `PickVisualMedia` | `PickVisualMediaRequest` → `Uri?` |
| 导入一份内容 | `GetContent` | MIME 类型 → `Uri?` |
| 打开文档 | `OpenDocument` | MIME 类型数组 → `Uri?` |
| 创建文档 | `CreateDocument(mimeType)` | 建议文件名 → `Uri?` |
| 选择目录树 | `OpenDocumentTree` | 可选初始 `Uri` → `Uri?` |

`TakePicture` 返回的是写入是否成功，照片在调用前准备好的 Uri 中。`TakePicturePreview` 返回的才是小尺寸 Bitmap。录像使用 `CaptureVideo`；旧 `TakeVideo` 依赖缩略图来判断录像结果，已经弃用。[ActivityResultContracts API](https://developer.android.com/reference/androidx/activity/result/contract/ActivityResultContracts)

文件选择时还要区分权限期限：`OpenDocument` 适合继续访问原文档，需要长期访问时再保留持久化 Uri 授权；`GetContent` 更适合取回内容并导入应用自己的存储。把 Uri 字符串写进数据库，本身不会延长授权。

## 自定义一个城市选择合约

自定义 Contract 的价值在于把组件协议集中起来。调用方只关心初始城市名和最终选中的城市名，extra 的 key、结果码判断都由合约承接。

```kotlin
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContract

/** Describe the input and output of the in-app city picker. */
class PickCityContract : ActivityResultContract<String, String?>() {
    /** Create a request carrying the currently selected city. */
    override fun createIntent(context: Context, input: String): Intent =
        Intent(context, CityPickerActivity::class.java)
            .putExtra("initial_city", input)

    /** Return a city only when the picker completes successfully. */
    override fun parseResult(resultCode: Int, intent: Intent?): String? =
        if (resultCode == Activity.RESULT_OK) {
            intent?.getStringExtra("selected_city")
        } else {
            null
        }
}

/** Offer a small, deterministic set of cities for the contract example. */
class CityPickerActivity : ComponentActivity() {
    /** Render choices and return the selected value to the caller. */
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val initialCity = intent.getStringExtra("initial_city")
        val choices = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        listOf("北京", "上海", "武汉").forEach { city ->
            choices.addView(Button(this).apply {
                text = if (city == initialCity) "$city（当前）" else city
                setOnClickListener {
                    setResult(
                        Activity.RESULT_OK,
                        Intent().putExtra("selected_city", city)
                    )
                    finish()
                }
            })
        }
        setContentView(choices)
    }
}
```

把 `CityPickerActivity` 声明到应用 Manifest：

```xml
<activity
    android:name=".CityPickerActivity"
    android:exported="false" />
```

类所在的包需与这里的名称对应。调用方注册 `PickCityContract()`，再用 `launcher.launch("武汉")` 发起请求；用户直接返回时，回调得到 `null`。

对于能立即得到结果的操作，Contract 还可以实现 `getSynchronousResult()`，返回 `SynchronousResult<O>` 并省去 Activity 启动。它只负责这次输入的同步结果，不应在这里执行网络或阻塞 I/O。

## Compose 中保留相同的职责划分

Compose 使用 `rememberLauncherForActivityResult()` 管理 Launcher。仍然在组合中声明合约和结果回调，在用户事件中启动：

```kotlin
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable

/** Keep the selected city in restorable UI state. */
@Composable
fun CityButton() {
    var city by rememberSaveable { mutableStateOf("武汉") }
    val launcher = rememberLauncherForActivityResult(PickCityContract()) {
        selected -> if (selected != null) city = selected
    }
    Button(onClick = { launcher.launch(city) }) {
        Text("当前城市：$city")
    }
}
```

如果结果要更新业务数据，就把结果交给 ViewModel。Launcher 仍留在 UI 宿主中，ViewModel 接收“用户选择了哪个城市”这样的业务事件。

Activity Result API 解决的是请求与结果协议、注册和交付问题。文件访问是否有权限、输入是否需要保存、结果之后应修改什么业务状态，分别由存储层与状态层处理。把这些职责分开，合约才能保持小而清楚。

## 参考资料

- [Activity Result API 的注册、启动与自定义合约](https://developer.android.com/training/basics/intents/result)
- [ActivityResultContracts：内置合约与弃用说明](https://developer.android.com/reference/androidx/activity/result/contract/ActivityResultContracts)
- [系统 Photo Picker](https://developer.android.com/training/data-storage/shared/photo-picker)
- [SAF 文档访问与持久化授权](https://developer.android.com/training/data-storage/shared/documents-files)
