---
title: 'Kotlin 泛型型变：为什么能读，就未必能写'
description: '从一次不安全的容器赋值推导 out、in 与不变，理解声明处型变、类型投影、星投影，以及只读接口和不可变对象的区别。'
date: '2026-02-15T22:33:45+08:00'
categories: [Kotlin, 类型系统]
tags: [Kotlin, 泛型, 型变, 类型安全]
updated: '2026-10-15'
---

`String` 是 `Any` 的子类型，为什么 `MutableList<String>` 不能直接赋给 `MutableList<Any>`？原因藏在赋值之后：接收方可以往后者加入整数，而原来的调用方仍把同一份列表当作字符串列表。

型变要回答的正是这个问题：**当元素类型存在子类型关系时，包裹它的泛型类型能否沿用这种关系？** Kotlin 的 `out` 和 `in` 用操作能力换取安全的类型替换。

## 从一个不能成立的赋值开始

假设下面的赋值被允许：

```kotlin
val names: MutableList<String> = mutableListOf("Kotlin")
// This assignment is intentionally invalid.
val objects: MutableList<Any> = names
objects.add(42)
val lastName: String = names.last()
```

`objects` 和 `names` 指向同一个列表。最后一行要求取出字符串，实际取出的却可能是整数。Kotlin 在赋值处就拒绝了这种代码。

`MutableList<T>` 既能返回 `T`，又能接收 `T`。它对 `T` 是**不变的**：即使 `String <: Any`，也不能推出 `MutableList<String> <: MutableList<Any>`，反方向同样不成立。

这并不妨碍把 `MutableList<String>` 赋给 `List<String>`。这里改变的是接口能力，元素类型仍是 `String`。

## out：只把 T 提供给调用方

如果一个接口只负责生产值，替换关系就变得安全：

```kotlin
/** Supplies values without accepting replacements. */
interface Source<out T> {
    /** Returns the next available value. */
    fun next(): T
}

val words: Source<String> = object : Source<String> {
    override fun next(): String = "Kotlin"
}

val objects: Source<Any> = words
val value: Any = objects.next()
```

调用方通过 `Source<Any>` 取值时只要求拿到一个 `Any`，实际拿到 `String` 完全满足要求。接口没有接收任意 `Any` 的入口，也就无法破坏原来的字符串来源。

这种关系称为**协变**：

```text
String       <: Any
Source<String> <: Source<Any>
```

`out` 写在接口的类型参数声明处，属于声明处型变。接口设计者一次声明，所有使用者都能获得相应的替换规则。

只读集合 `List<out E>` 也采用了这个方向。`List<String>` 可以作为 `List<Any>` 使用，因为从字符串列表里读出的值当然也是 `Any`。

## in：只让调用方交进来 T

现在反过来，接口只负责消费值：

```kotlin
/** Accepts values for processing. */
interface Sink<in T> {
    /** Processes one value. */
    fun accept(value: T)
}

val anything: Sink<Any> = object : Sink<Any> {
    override fun accept(value: Any) {
        println(value)
    }
}

val words: Sink<String> = anything
words.accept("Kotlin")
```

能处理所有 `Any` 的消费者，当然也能处理字符串。赋值后，调用方通过 `Sink<String>` 只会交入字符串，底层对象的能力足够覆盖这些请求。

这里是**逆变**：

```text
String     <: Any
Sink<Any> <: Sink<String>
```

方向反转并不神秘：一个消费者能接受的范围越宽，能够胜任的场景就越多。例如，一个能比较任意 `Number` 的比较器，也能用于比较 `Int`。

| 类型参数的角色 | 声明方式 | 安全的替换方向 |
| --- | --- | --- |
| 提供值 | `Source<out T>` | `Source<String>` → `Source<Any>` |
| 接收值 | `Sink<in T>` | `Sink<Any>` → `Sink<String>` |
| 同时提供和接收值 | `MutableList<T>` | 两个方向都不自动成立 |

## 类型投影：限制这一次使用的能力

有些类型本身必须同时支持读写。例如 `Array<T>` 既有 `get`，又有 `set`，不能把整个类型声明成协变。

但一次具体操作可能只需要读取源数组、写入目标数组。可以在参数处声明这种限制：

```kotlin
/** Copies all source elements into a sufficiently large destination. */
fun <T> copyInto(from: Array<out T>, to: Array<in T>) {
    require(to.size >= from.size)
    for (index in from.indices) {
        to[index] = from[index]
    }
}

val names = arrayOf("Kotlin", "Java")
val values = arrayOf<Any>(0, false)
copyInto<String>(names, values)
println(values.contentToString()) // [Kotlin, Java]
```

`Array<out T>` 表示源数组中存在某个具体的元素类型，它是 `T` 的子类型。读取时可以将元素当作 `T`，写入时却不知道底层真正接受的是哪一种子类型，所以不能随意放入一个 `T`。

`Array<in T>` 则保证目标数组能接收 `T`。读取时，只能得到其安全的上界；对于这里没有额外上界约束的 `T`，这个类型是 `Any?`。

类型投影没有复制数组，也没有改变数组的实际内容。它改变的是函数通过这个引用能够执行的操作。Java 中的 `? extends T` 和 `? super T` 分别对应类似的使用处限制；Kotlin 还允许把限制直接写在类型声明上。

## 嵌套函数类型中的输入与输出位置

简单接口里，参数位置通常是输入，返回值位置通常是输出。嵌套函数类型会让方向发生组合：

```kotlin
/** Exposes values by invoking a consumer. */
interface Stream<out T> {
    /** Invokes the action for each available value. */
    fun forEach(action: (T) -> Unit)
}
```

这里的 `T` 虽然写在 `forEach` 的参数声明里，但它是回调函数的输入。`Stream` 接收回调，再把自己生产的 `T` 交给回调。两层输入位置组合后，`T` 对 `Stream` 仍处于输出方向。

判断型变时，需要沿着嵌套类型追踪值的流向。函数类型本身也遵循相同规则：参数类型逆变，返回类型协变。

## 星投影：不知道具体类型，也能安全使用

`List<*>` 表示某种元素类型未知的列表。它和 `List<Any?>` 的表达重点不同：前者承认类型未知，后者明确把元素类型指定为 `Any?`。

对于一个 `MutableList<*>`：

```kotlin
val unknown: MutableList<*> = mutableListOf("Kotlin")
val first: Any? = unknown.first()

// unknown.add("Java") // Invalid: the element type is unknown.
// unknown.add(null)   // Invalid for the same reason.
unknown.clear()
```

读取可以得到 `Any?`，写入则无法证明某个值符合未知类型。`clear()` 仍然合法，因为它不需要接收一个元素。

如果类型参数有更窄的上界，比如 `T : CharSequence`，星投影读取出来的值也具有这个上界。星投影让未知类型仍能参与安全的操作。

## 只读接口与不可变对象是两件事

`out` 约束类型替换，`List` 限制当前引用可用的操作，它们都不自动冻结底层对象：

```kotlin
val editable = mutableListOf("Kotlin")
val readable: List<String> = editable
editable.add("Java")
println(readable) // [Kotlin, Java]
```

如果需要稳定快照，可以复制列表；如果元素本身可变，还要进一步考虑元素的共享关系。并发安全同样需要独立设计。

设计泛型 API 时，可以先列出调用方需要的操作：只取值就考虑 `out`，只交值就考虑 `in`，两者都有则保留不变，再用类型投影缩小特定函数所需的能力。这样的签名既放宽了合理调用，也把不安全的写入挡在编译期。

## 参考资料

- [Kotlin：泛型、声明处型变与类型投影](https://kotlinlang.org/docs/generics.html)
- [Kotlin：集合概览与只读接口](https://kotlinlang.org/docs/collections-overview.html)
- [Kotlin：函数类型](https://kotlinlang.org/docs/lambdas.html#function-types)
