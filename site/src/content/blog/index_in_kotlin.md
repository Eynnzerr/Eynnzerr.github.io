---
title: 'Kotlin 中的 ''[]'''
date: '2025-09-08T15:53:59+08:00'
updated: '2026-03-06T11:12:05.073Z'
legacyPath: /2025/09/08/index_in_kotlin/
categories:
  - Kotlin
tags:
  - Kotlin
---

## Kotlin 的 `[]` 到底是什么

刚写 Kotlin 时，我就很快爱上了 `map["key"]`、`list[i]` 这种简洁的 `[]` 写法。它看起来就像在其他语言中早已熟悉的“下标访问”，但更准确的说法是：**`[]` 是编译器提供的运算符约定（operator convention）语法糖**。它既能访问 List/Array，也能用于 Map，甚至可以被自定义到任何类型上。

---

## 1) `[]` 的原理：编译期改写为 `get/set`

Kotlin 的 `[]` 并不是某种“运行时特性”。编译器会把它**静态地改写**成函数调用：

- 读取：`a[b]`  →  `a.get(b)`
- 写入：`a[b] = c`  →  `a.set(b, c)`

只要我们为类型（成员函数或扩展函数）提供了相应签名，并用 `operator` 修饰，就可以使用 `[]`。一个简单的自定义类实现例子如下：

```kotlin
class Grid<T>(private val data: Array<Array<T>>) {
    operator fun get(x: Int, y: Int): T = data[x][y]
    operator fun set(x: Int, y: Int, v: T) { data[x][y] = v }
}

fun main() {
	val g = Grid(arrayOf(arrayOf(1, 2), arrayOf(3, 4)))
	println(g[1, 0]) // 等价于 g.get(1, 0)
	g[0, 1] = 9      // 等价于 g.set(0, 1, 9)
}
```

然而细心的小伙伴可能就已注意到了：当我们在 Kotlin 中使用 `mutableMapOf<K, V>()` 在底层创建`java.util.LinkedHashMap<K, V>`时， Java 类本身并没有定义`set`方法，我们却仍可以在 Kotlin 侧直接用索引语法。这是因为其借助了 Kotlin 另一个强大的功能：**扩展方法**。

```kotlin
@kotlin.internal.InlineOnly  
public inline operator fun <@kotlin.internal.OnlyInputTypes K, V> Map<out K, V>.get(key: K): V? =  
    @Suppress("UNCHECKED_CAST") (this as Map<K, V>).get(key)  
  
/**  
 * Allows to use the index operator for storing values in a mutable map. */@kotlin.internal.InlineOnly  
public inline operator fun <K, V> MutableMap<K, V>.set(key: K, value: V): Unit {  
    put(key, value)  
}
```

另外，在 Kotlin/Java 互操作里，**只要 Java 类上确实存在符合签名的 `get(...)` / `set(...)` 实例方法，Kotlin 侧通常就可以直接用 `[]`**——不需要在 Java 里写什么 `operator`（Java 也没这个关键字）。Kotlin 编译器会把 `a[i]`/`a[i]=v` 按“运算符约定”解析到这些方法上。

> 关键点 

- **索引参数不必一定是 Int**：Map 的 key 就是泛型 `K`。
- `a[x, y]` 这种“多参数索引”是合法的，本质是 `get(x, y)`。
- 这是**编译期语法糖**：是否能用 `[]`，由静态类型上有没有匹配的 `operator get/set` 决定。

---

## 2) Kotlin 标准集合里 `[]` 的语义：Map ≠ List/Array

虽然都用 `[]`，但 Map 与 List/Array 的失败策略完全不同。这是 Kotlin 设计中很重要的语义区分，写码时也需要注意。

### 2.1 Map：查询语义（缺失返回 null）

对 `Map<K, V>`：

- `map[key]` 会调用 `get(key)`
- **key 不存在 → 返回 `null`**
- 因此返回类型通常是 **`V?`**

```kotlin
val m = mapOf("a" to 1)
println(m["a"]) // 1
println(m["b"]) // null
```

注意：即使 key 存在，value 也可能是 `null`（当 `V` 允许为 null 时）。所以 `null` 可能表示两种情况：

1) key 不存在  
2) key 存在但 value 本来就是 null

如果希望“缺 key 就直接失败（抛异常等）”，常见的处理方式是：

- `map.getValue(key)`：缺失抛 `NoSuchElementException`
- `requireNotNull(map[key])`
- `map[key] ?: error("...")`

### 2.2 List / Array / String：索引语义（越界抛异常）

对 `List`、`Array`、`String`：

- `list[i]` / `arr[i]` / `s[i]` 是严格索引访问
- **越界会抛异常**（如 `IndexOutOfBoundsException`、`StringIndexOutOfBoundsException`）

```kotlin
val list = listOf(10, 20)
println(list[1]) // 20
println(list[2]) // 抛异常
```

Kotlin也提供了更安全的替代版本：

- `getOrNull(i)`：越界返回 `null`
- `getOrElse(i) { default }`：越界返回默认值

```kotlin
println(list.getOrNull(2))         // null
println(list.getOrElse(2) { -1 })  // -1
```

### 2.3 Set：通常没有 `[]`

`Set` 不支持“按位置”或“按 key”索引，因此没有 `set[i]` 这种形式。常用的是：

- `x in set` / `set.contains(x)` 判断元素是否存在

---

## 3) 和 C / Java / Python 的 `[]` 对比

`[]` 是一个长得很像、但在不同语言里“底层机制与语义”差别极大的符号。如果你像我一样日常需要经常在不同语言的项目间来回切换时，可能会搞混，或者直接认为 Kotlin的 `[]` 与其他语言完全是一种东西。然而他们虽为同一个符号，实际却有着不同的契约。

### 3.1 Kotlin vs Java：Java 没有通用的 `[]` 重载

Java 的 `[]` 只用于数组访问（和数组类型语法），例如 `arr[i]`。  
Java **不能**把 `obj[key]` 解释成方法调用（没有运算符重载），所以 Java 中 Map 访问只能写：

```java
map.get(key)
```

而 Kotlin 的 `map[key]` 对 JVM 来说仍然只是一次 `get(key)` 方法调用，是 Kotlin 编译器提供的语法糖。

### 3.2 Kotlin vs C：C 的 `[]` 是指针算术（无边界检查）

C 里 `a[i]` 等价于 `*(a + i)`：

- 越界通常是**未定义行为**（可能崩溃，也可能悄悄读错）
- 不存在“缺失返回 null”的统一约定

而Kotlin 的 List/Array 越界是**受控失败（抛异常）**，错误更可见、更可定位。

### 3.3 Kotlin vs Python：都“像方法”，但 Kotlin 是静态的、Python 更动态

Python 的：

- `obj[key]` → `obj.__getitem__(key)`
- `obj[key] = v` → `obj.__setitem__(key, v)`

这和 Kotlin 的“映射到方法”很相似，但差异非常关键：

- **动态 vs 静态**：Python 在运行时决定调用谁；Kotlin 在编译期由静态类型解析 `get/set`。
- **切片语法**：Python 有内建 `a[1:5]`（slice）。  
  Kotlin **没有内建切片 `[]`**：`list[1..5]` 默认不表示切片（除非自己定义 `get(IntRange)`）。
- **负数索引**：Python `a[-1]` 是最后一个元素；Kotlin `list[-1]` 会越界异常（没有特殊语义）。

### 3.4 Kotlin vs C++：都可重载，但容器默认行为不同

C++ 也能重载 `operator[]`，但很多容器的 `operator[]` 语义可能是“缺 key 自动插入默认值”（如 `std::map`）。  
Kotlin 的 Map `[]` **不会插入**，它是纯查询；要写入必须显式调用 `map[key] = value`。

---

> 注意

1. **List/Array/String 的 `[]` 越界就抛异常**，不像 C 那样“可能悄悄错”。  
2. **Kotlin 没有 Python 那种内建切片**；`list[1..3]` 不是默认用法。  
3. **Kotlin 的 `[]` 解析看静态类型**：能不能用、用哪个 `get`，编译期就决定了。  
4. **Kotlin Map 的 `[]` 不会像某些 C++ 容器那样访问即插入**。

---

## 4) 总结

- Kotlin 的 `[]` 是**编译器把语法改写成 `operator get/set` 调用**。  
- `Map` 的 `[]` 是“查询”，**缺失返回 null**；`List/Array/String` 的 `[]` 是“索引”，**越界抛异常**。  
- 虽然符号相同，但和 C（指针算术）、Java（无重载）、Python（动态 + 切片/负索引）相比，**契约差异很大**，跨语言迁移时要特别留意。

--- 

### 附：自用速查

| 场景             | Kotlin 写法          | 失败行为            |
| ---------------- | -------------------- | ------------------- |
| Map 查值         | `map[key]`           | key 不存在 → `null` |
| Map 强制必须存在 | `map.getValue(key)`  | 不存在 → 抛异常     |
| List/Array 索引  | `list[i]` / `arr[i]` | 越界 → 抛异常       |
| 安全索引         | `list.getOrNull(i)`  | 越界 → `null`       |
| Set 判断存在     | `x in set`           | 返回 `true/false`   |
