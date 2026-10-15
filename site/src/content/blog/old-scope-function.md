---
title: Scope Function 速记速查
date: '2025-09-02T10:06:25+08:00'
updated: '2026-01-30T04:40:01.256Z'
legacyPath: /2025/09/02/old-scope-function/
categories:
  - Kotlin
tags:
  - Kotlin
  - 域函数
---
**该篇内容为原博客博文，原上传于2021年11月29日。**

# 前言

kotlin是一款十分灵活而又强大的语言。合理地运用kotlin的一些特性，可以极大地提高代码可读性和质量，提高效率。下面我们就来说一说kotlin中的**scope function**。

# 域函数

我们主要介绍**let, also, with, run, apply**这五种常用的域函数。

### (1)let

先上let函数的源码：

```kotlin
    public inline fun <T, R> T.let(block: (T) -> R): R {
        contract {
            callsInPlace(block, InvocationKind.EXACTLY_ONCE)
        }
        return block(this)
    }
```

从源码我们可以看出，首先，let是对调用者的扩展函数。其次，let函数接收一个lambda表达式block作为唯一参数，且将调用者本身作为参数传给了lambda。而在函数的内部，首先使用contract进行约束，向编译器表明这个lambda只会执行一次（EXACTLY_ONCE），接着就是调用lambda并返回其返回值。
进而，我们可以得出如下结论：

1. 由于let函数将调用者作为lambda的参数，因而在let闭包内，可以用**it**指代调用者；
2. let函数是具有返回值的，且其返回值应为lambda表达式中的最后一行/return语句。

随之，我们可以得到let函数的作用：

1. 在明确某一对象实例在一定范围内需要使用时，可以对其调用let，再用it指代；
2. （常用）对某一可能为空的对象进行统一判空的处理。

这里对作用二作一些解释。对于一个可能为空的对象object，如果不使用let，每次调用其方法或属性时，都要加上?或者!!，以及类似if not null的判空逻辑。但如果使用let，代码就将简化为如下的形式：

```kotlin
    object?.let {
        it.doSomething()
        it.id = 0
    }
```

以上代码表示，只有当object不为空时，才会执行let中的逻辑，且由于判空交给了object后的?符来处理，let内部不再需要任何多余的判空。如此以来，判空就变得优雅了许多。

### (2)also

先上also函数的源码：

```kotlin
    public inline fun <T> T.also(block: (T) -> Unit): T {
        contract {
            callsInPlace(block, InvocationKind.EXACTLY_ONCE)
        }
        block(this)
        return this
    }
```

从源码可见，also函数的实现思路与let类似，都是对调用者的扩展，都是将调用者作为参数传给lambda，都使用contract进行调用约束，都会在内部执行lambda。但有如下不同：lambda没有返回值，而从return语句看，also返回的是调用者本身。
进而，我们可以得出如下结论：

1. also函数的应用场景与let相同；
2. also函数返回值为调用者本身。

### (3)with

先上with函数的源码：

```kotlin
    public inline fun <T, R> with(receiver: T, block: T.() -> R): R {
        contract {
            callsInPlace(block, InvocationKind.EXACTLY_ONCE)
        }
        return receiver.block()
    }
```

虽然源码的整体风格和之前两者类似，但其使用方法却截然不同。首先，with是一个通用的扩展函数，其有两个参数：receiver，和一个lambda。注意这里lambda的参数是T.()，它表明将这个lambda函数作为同为类型T的receiver的一个扩展函数，从而能被receiver所调用。进而，我们可以得出如下结论：

1. 由于with内部是通过扩展函数使得receiver去调用lambda，因而可以在lambda的闭包内部直接访问receiver的public方法/属性。（即没有it等间接指代值）
2. with函数是具有返回值的。从源码的return语句可以看出，其返回的是lambda表达式的最后一行/return语句。

随之，我们可以得到with函数的作用：
在需要多次调用某一对象的方法或属性时，可以将该对象传给with，再在with内部处理相应逻辑。这样写可以避免多次重复地写该对象。
举个栗子：当我们想写一个alertDialog时，需要先创建builder，对builder进行一系列配置，再调用builder的create()方法返回一条alertDialog。有了with后，我们可以这样写：

```kotlin
    private lateinit var alertDialog: AlertDialog

    ...

    val builder = AlertDialog.Builder(activity)
    alertDialog = with (builder) {
        val alertView = layoutInflater.inflate(R.layout.dialog_confirm, null, false)
        setView(alertView)
        setNegativeButton("取消") { dialog, which ->
            Toast.makeText(activity, "已取消", Toast.LENGTH_SHORT).show()
        }
        setPositiveButton("确定") { dialog, which ->
            run {
                bill?.let { it1 -> viewModel.deleteBill(it1) }
                activity?.onBackPressed()
            }
        }
        create()
    }
```

是不是简洁了许多？

### (4)run

还是先上源码：

```kotlin
    public inline fun <R> run(block: () -> R): R {
        contract {
            callsInPlace(block, InvocationKind.EXACTLY_ONCE)
        }
        return block()
    }

    public inline fun <T, R> T.run(block: T.() -> R): R {
        contract {
            callsInPlace(block, InvocationKind.EXACTLY_ONCE)
        }
        return block()
    }
```

run有点类似let和with的结合体，继承了两者各自的优点，因而使用场景十分广泛：首先，它像let一样是对调用者的扩展，因而可以**统一判空处理**；其次，它又像with一样，传入lambda的是T.()，表明它可以像with一样**在闭包内直接访问方法/属性**。最后，它返回的是lambda的返回值。

### (5)apply

上源码。。。

```kotlin
    public inline fun <T> T.apply(block: T.() -> Unit): T {
        contract {
            callsInPlace(block, InvocationKind.EXACTLY_ONCE)
        }
        block()
        return this
    }
```

不难看出，apply和run类似于also和let的关系，使用场景类似，只是返回值有差异。
而由于apply返回的是调用者本身，因而它十分适合用来做变量的初始化。

# 总结

| 函数名 |                   特点                    |                    作用                    |
| :----: | :---------------------------------------: | :----------------------------------------: |
|  let   |   1.在指定域内定义变量it 2.返回最后一行   |                统一判空处理                |
|  also  | 1.在指定域内定义变量it 2.返回传入对象本身 |                统一判空处理                |
|  with  |    1.直接访问方法和属性 2.返回最后一行    |            多次调用时省去变量名            |
|  run   |     1.let和with的结合 2.返回最后一行      | 统一判空的同时省去it，省去变量名的同时判空 |
| apply  |        1.同run 2.返回传入对象本身         |        同run，此外适用于初始化变量         |

作者纯kotlin小白，如有疏漏与错误，敬请大佬指正！
