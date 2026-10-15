---
title: '从 Lambda 到 fold：把变化的计算规则交给函数'
description: '用完整的计算示例理解函数类型、闭包、Lambda 返回与 inline，再从累加器的变化过程推导 fold、reduce 和 runningFold。'
date: '2026-03-19T16:09:39+08:00'
categories: [Kotlin, 函数与集合]
tags: [Kotlin, 高阶函数, Lambda, fold, reduce]
updated: '2026-10-15'
---

高阶函数把一段行为变成参数。遍历、筛选、累计这些稳定流程可以留在函数内部，而“筛选什么”“怎样累计”由调用方提供。Lambda 是描述这段行为的一种语法。

理解它们，可以从一次只有两步的计算开始，再扩展到集合聚合。

## 让计算规则成为参数

```kotlin
/** Applies a binary operation to two integer operands. */
fun calculate(left: Int, right: Int, operation: (Int, Int) -> Int): Int {
    return operation(left, right)
}

val sum = calculate(7, 3) { left, right -> left + right }
val difference = calculate(7, 3) { left, right -> left - right }
println(sum)        // 10
println(difference) // 4
```

`(Int, Int) -> Int` 是函数类型：接收两个整数，返回一个整数。`calculate` 接收这种类型的值，再像调用普通函数一样调用它。

最后一个参数是函数时，可以把 Lambda 放到圆括号外。Lambda 的参数写在 `->` 左边，函数体写在右边，最后一个表达式成为结果。

函数也可以先存到变量里，或者使用已有函数的引用：

```kotlin
val multiply: (Int, Int) -> Int = { left, right -> left * right }
println(calculate(7, 3, multiply)) // 21
println(calculate(7, 3, ::maxOf)) // 7
```

高阶函数不仅可以接收函数，也可以返回函数。判断标准是它的参数或返回值包含函数，和函数体有多长无关。

## 闭包保存的是可访问的环境

Lambda 可以访问外层变量。下面的工厂函数每次调用都会创建独立的一份计数状态：

```kotlin
/** Creates a counter intended for sequential calls. */
fun makeCounter(start: Int): () -> Int {
    var current = start
    return {
        current += 1
        current
    }
}

val first = makeCounter(10)
val second = makeCounter(100)
println(first())  // 11
println(first())  // 12
println(second()) // 101
```

`makeCounter` 返回后，`current` 仍能通过返回的函数继续访问。这个函数和它捕获的环境共同构成闭包。

捕获可变变量也意味着共享状态。如果多个线程同时调用同一个 `first`，`current += 1` 仍然存在读改写竞争。把代码写进 Lambda，不会自动获得线程安全。

还可以使用带接收者的函数类型。例如 `StringBuilder.() -> Unit` 让函数体内能够直接调用 `append`：

```kotlin
val configure: StringBuilder.() -> Unit = {
    append("Kotlin")
    append(" / ")
    append("Java")
}
val text = StringBuilder().apply(configure).toString()
println(text) // Kotlin / Java
```

这也是许多构建器 DSL 的基础：接收者提供操作环境，Lambda 提供具体的构建步骤。

## Lambda 的 return 究竟返回到哪里

普通命名函数的 `return` 返回当前函数。Lambda 需要区分局部返回和内联允许的非局部返回。

```kotlin
/** Finds the first positive value, or returns null. */
fun firstPositive(values: List<Int>): Int? {
    values.forEach { value ->
        if (value <= 0) return@forEach
        return value
    }
    return null
}
```

`return@forEach` 结束当前这一次 Lambda 调用，遍历继续。后面的 `return value` 则直接退出 `firstPositive`。后者成立，是因为这里调用的集合 `forEach` 是内联函数，Lambda 允许非局部返回。

换成把回调保存起来、稍后调用的普通函数，就不能在回调中这样退出外层函数。匿名函数的规则也更直接：`fun(value: Int): Boolean { return value > 0 }` 中的 `return` 返回这个匿名函数本身。

这个例子用于看清返回位置，实际查找通常直接写 `values.firstOrNull { it > 0 }`，意图更清楚。

`inline` 可以把函数体和可内联的 Lambda 展开到调用处，减少部分函数对象与间接调用开销，同时可能增加生成代码的体积。`noinline` 允许某个函数参数作为普通函数值保存或传递；`crossinline` 则禁止该参数里的非局部返回，适用于需要在另一个调用环境中执行它的实现。是否分配对象还取决于编译器、后端和具体用法，不宜仅凭“写了 Lambda”判断。

## fold：把循环中的累加器显式写出来

考虑一个简单需求：统计一组整数金额的笔数和总额。先写出普通循环：

```kotlin
val amounts = listOf(120L, -30L, 50L)
var count = 0
var sum = 0L
for (amount in amounts) {
    count += 1
    sum += amount
}
```

循环维护一份状态，每读入一个元素就更新一次。`fold` 把这份状态叫作累加器，把更新规则交给 Lambda：

```kotlin
/** Holds an aggregate over integer amounts. */
data class Totals(
    /** Number of included entries. */
    val count: Int,
    /** Sum in the same unit as the input amounts. */
    val amount: Long,
)

val amounts = listOf(120L, -30L, 50L)
val totals = amounts.fold(Totals(0, 0L)) { accumulated, amount ->
    Totals(
        count = accumulated.count + 1,
        amount = accumulated.amount + amount,
    )
}
println(totals) // Totals(count=3, amount=140)
```

它的执行顺序是：

| 当前元素 | 进入 Lambda 的累加器 | 返回的新累加器 |
| --- | --- | --- |
| `120` | `(0, 0)` | `(1, 120)` |
| `-30` | `(1, 120)` | `(2, 90)` |
| `50` | `(2, 90)` | `(3, 140)` |

元素类型是 `Long`，结果类型是 `Totals`。`fold` 的初始值决定了累加器类型，结果不必与元素类型相同。输入为空时，Lambda 一次也不会执行，直接返回初始值。

这段写法强调每一步产生一个新状态。如果某个热点循环需要减少对象创建，可以选择局部可变累加器或普通循环。高阶函数提供的是表达方式，具体成本仍要结合实际调用路径判断。

## reduce：把第一个元素用作初始状态

如果输入本身就能充当累加器，可以不另外提供初始值：

```kotlin
val values = listOf(10, 3, 2)
val folded = values.fold(0) { total, value -> total + value }
val reduced = values.reduce { total, value -> total + value }
println(folded)  // 15
println(reduced) // 15
```

`fold` 从 `0` 开始，调用三次 Lambda；`reduce` 从 `10` 开始，只调用两次。单元素集合的 `reduce` 直接返回那个元素。

空输入没有可取的第一个元素。标准库的 `reduce` 会抛出 `UnsupportedOperationException`；`reduceOrNull` 在空输入上返回 `null`。如果空集合的结果有自然定义，例如求和的 `0`，`fold` 或专用的 `sum()` 往往更合适。

从类型上说，`reduce` 的累加器受元素类型及其超类型约束；`fold` 可以选择独立的结果类型。两者的区别不只是“是否少写一个初始值”。

## 方向和中间状态也属于计算规则

加法容易掩盖顺序差异，减法就很清楚：

```kotlin
val values = listOf(10, 3, 2)
println(values.reduce { acc, value -> acc - value })
// (10 - 3) - 2 = 5

println(values.reduceRight { value, acc -> value - acc })
// 10 - (3 - 2) = 9
```

右折叠不仅改变遍历方向，Lambda 参数顺序也变成了 `(element, accumulator)`。浮点运算同样可能受顺序影响，因为舍入会破坏理想实数加法的结合律。

需要观察每一步状态时，使用 `runningFold` 或 `runningReduce`：

```kotlin
val changes = listOf(120L, -30L, 50L)
println(changes.runningFold(0L) { balance, change -> balance + change })
// [0, 120, 90, 140]
println(changes.runningReduce { balance, change -> balance + change })
// [120, 90, 140]
```

`runningFold` 包含初始状态，结果比输入多一个元素；`runningReduce` 从首个元素开始。对普通集合和数组，这些调用直接产生结果集合。`Sequence.runningFold` 返回惰性序列，而 `Sequence.fold` 是终止操作，调用时会消费整个序列。

集合、数组、字符串和序列都有适用的聚合扩展；`Map` 可以先选择 `entries`、`keys` 或 `values`。选 API 时先确定三件事：空输入怎样处理、结果是什么类型、是否需要中间状态。答案明确后，函数名通常就自然确定了。

## 参考资料

- [Kotlin：高阶函数与 Lambda](https://kotlinlang.org/docs/lambdas.html)
- [Kotlin：内联函数与非局部返回](https://kotlinlang.org/docs/inline-functions.html)
- [Kotlin 标准库：fold](https://kotlinlang.org/api/core/kotlin-stdlib/kotlin.collections/fold.html)
- [Kotlin 标准库：reduce](https://kotlinlang.org/api/core/kotlin-stdlib/kotlin.collections/reduce.html)
- [Kotlin 标准库：Sequence.runningFold](https://kotlinlang.org/api/core/kotlin-stdlib/kotlin.sequences/running-fold.html)
