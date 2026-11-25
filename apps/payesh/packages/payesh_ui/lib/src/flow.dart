// Row 185: no empty stretches. A page's blocks sit side by side in columns (the owner: «پایه‌ها،
// رشته‌ها و کلاس‌ها سه ستون کنار هم» — «حذف فضاهای بیخود و اضافی در کل برنامه»): every block
// goes under the shortest column, so a short card never leaves a hole. A phone keeps one column.
// ignore_for_file: prefer_initializing_formals -- private fields with setters behind named parameters
import 'dart:math' as math;

import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

/// Narrowest column of a [FlowColumns] page — a phone (360) still fits one.
const double kFlowColumnMin = 340;

/// Most columns a page gets.
const int kFlowColumnsMax = 3;

/// Gap between two columns.
const double kFlowGap = 12;

/// How many columns fit [width].
int flowColumnsFor(
  double width, {
  double min = kFlowColumnMin,
  int max = kFlowColumnsMax,
  double gap = kFlowGap,
}) => ((width + gap) / (min + gap)).floor().clamp(1, max);

/// Marks a block that needs the whole width (a table with many columns, the schedule grid…):
/// [FlowColumns] puts it on its own line, the blocks around it keep flowing in columns.
class FlowWide extends StatelessWidget {
  const FlowWide({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => child;
}

/// Marks a block that flows in a column although [FlowColumns.wide] would give it the full
/// width (a card wrapped in a builder, say).
class FlowCell extends StatelessWidget {
  const FlowCell({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => child;
}

/// Lays [children] in as many columns as fit (at least [min] wide each, at most [max]); each
/// child goes under the shortest column, the first one on the start side (right in Persian).
/// [FlowWide] children break the flow and take the full width. With one column it is a plain
/// stretched [Column].
class FlowColumns extends StatelessWidget {
  const FlowColumns({
    super.key,
    required this.children,
    this.min = kFlowColumnMin,
    this.max = kFlowColumnsMax,
    this.gap = kFlowGap,
    this.wide,
  });
  final List<Widget> children;
  final double min;
  final int max;
  final double gap;

  /// Which children take the full width ([FlowWide] always does, [FlowCell] never does).
  final bool Function(Widget child)? wide;

  bool _wide(Widget c) =>
      c is FlowWide || (c is! FlowCell && (wide?.call(c) ?? false));

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final n = box.maxWidth.isFinite
          ? flowColumnsFor(box.maxWidth, min: min, max: max, gap: gap)
          : 1;
      if (n == 1) {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: children,
        );
      }
      final out = <Widget>[];
      var run = <Widget>[];
      void flush() {
        if (run.isEmpty) return;
        // a short run fills the line (two cards: two halves, not two thirds and a hole)
        final cols = math.min(n, run.length);
        out.add(
          cols == 1
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: run,
                )
              : MasonryColumns(columns: cols, gap: gap, children: run),
        );
        run = <Widget>[];
      }

      for (final c in children) {
        if (_wide(c)) {
          flush();
          out.add(c);
        } else {
          run.add(c);
        }
      }
      flush();
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: out,
      );
    },
  );
}

/// [columns] equal columns [gap] apart; every child takes the column that is shortest so far.
class MasonryColumns extends MultiChildRenderObjectWidget {
  const MasonryColumns({
    super.key,
    required this.columns,
    this.gap = kFlowGap,
    required super.children,
  });
  final int columns;
  final double gap;

  @override
  RenderMasonryColumns createRenderObject(BuildContext context) =>
      RenderMasonryColumns(
        columns: columns,
        gap: gap,
        textDirection: Directionality.maybeOf(context) ?? TextDirection.rtl,
      );

  @override
  void updateRenderObject(
    BuildContext context,
    RenderMasonryColumns renderObject,
  ) {
    renderObject
      ..columns = columns
      ..gap = gap
      ..textDirection = Directionality.maybeOf(context) ?? TextDirection.rtl;
  }
}

class _MasonryData extends ContainerBoxParentData<RenderBox> {}

class RenderMasonryColumns extends RenderBox
    with
        ContainerRenderObjectMixin<RenderBox, _MasonryData>,
        RenderBoxContainerDefaultsMixin<RenderBox, _MasonryData> {
  RenderMasonryColumns({
    required int columns,
    required double gap,
    required TextDirection textDirection,
  }) : _columns = columns,
       _gap = gap,
       _textDirection = textDirection;

  int _columns;
  int get columns => _columns;
  set columns(int v) {
    if (v == _columns) return;
    _columns = v;
    markNeedsLayout();
  }

  double _gap;
  double get gap => _gap;
  set gap(double v) {
    if (v == _gap) return;
    _gap = v;
    markNeedsLayout();
  }

  TextDirection _textDirection;
  TextDirection get textDirection => _textDirection;
  set textDirection(TextDirection v) {
    if (v == _textDirection) return;
    _textDirection = v;
    markNeedsLayout();
  }

  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! _MasonryData) child.parentData = _MasonryData();
  }

  double _columnWidth(double width) =>
      math.max(0, (width - _gap * (_columns - 1)) / _columns);

  Size _place({required bool dry, required BoxConstraints constraints}) {
    final width = constraints.maxWidth;
    final colW = _columnWidth(width);
    final heights = List<double>.filled(_columns, 0);
    var child = firstChild;
    while (child != null) {
      var col = 0;
      for (var i = 1; i < _columns; i++) {
        if (heights[i] < heights[col] - 0.5) col = i;
      }
      final cc = BoxConstraints.tightFor(width: colW);
      final Size s;
      if (dry) {
        s = child.getDryLayout(cc);
      } else {
        child.layout(cc, parentUsesSize: true);
        s = child.size;
        final x = _textDirection == TextDirection.rtl
            ? width - (col + 1) * colW - col * _gap
            : col * (colW + _gap);
        (child.parentData! as _MasonryData).offset = Offset(x, heights[col]);
      }
      heights[col] += s.height;
      child = childAfter(child);
    }
    return constraints.constrain(Size(width, heights.reduce(math.max)));
  }

  @override
  void performLayout() {
    size = _place(dry: false, constraints: constraints);
  }

  @override
  Size computeDryLayout(BoxConstraints constraints) =>
      _place(dry: true, constraints: constraints);

  @override
  double computeMinIntrinsicWidth(double height) {
    var w = 0.0;
    var child = firstChild;
    while (child != null) {
      w = math.max(w, child.getMinIntrinsicWidth(height));
      child = childAfter(child);
    }
    return w * _columns + _gap * (_columns - 1);
  }

  @override
  double computeMaxIntrinsicWidth(double height) {
    var w = 0.0;
    var child = firstChild;
    while (child != null) {
      w = math.max(w, child.getMaxIntrinsicWidth(height));
      child = childAfter(child);
    }
    return w * _columns + _gap * (_columns - 1);
  }

  @override
  double computeMinIntrinsicHeight(double width) =>
      _place(dry: true, constraints: BoxConstraints(maxWidth: width)).height;

  @override
  double computeMaxIntrinsicHeight(double width) =>
      computeMinIntrinsicHeight(width);

  @override
  void paint(PaintingContext context, Offset offset) =>
      defaultPaint(context, offset);

  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) =>
      defaultHitTestChildren(result, position: position);
}

/// Row 185: a [Wrap] whose widest size counts the gaps between its children (Flutter's own leaves
/// [spacing] out, so a row of buttons in a content-wide table cell broke onto two lines).
class SpacedWrap extends Wrap {
  const SpacedWrap({
    super.key,
    super.spacing,
    super.runSpacing,
    super.alignment,
    super.crossAxisAlignment,
    super.runAlignment,
    super.children,
  });

  @override
  RenderWrap createRenderObject(BuildContext context) => _RenderSpacedWrap(
    direction: direction,
    alignment: alignment,
    spacing: spacing,
    runAlignment: runAlignment,
    runSpacing: runSpacing,
    crossAxisAlignment: crossAxisAlignment,
    textDirection: textDirection ?? Directionality.maybeOf(context),
    verticalDirection: verticalDirection,
    clipBehavior: clipBehavior,
  );
}

class _RenderSpacedWrap extends RenderWrap {
  _RenderSpacedWrap({
    super.direction,
    super.alignment,
    super.spacing,
    super.runAlignment,
    super.runSpacing,
    super.crossAxisAlignment,
    super.textDirection,
    super.verticalDirection,
    super.clipBehavior,
  });

  @override
  double computeMaxIntrinsicWidth(double height) {
    final w = super.computeMaxIntrinsicWidth(height);
    return direction == Axis.horizontal && childCount > 1
        ? w + spacing * (childCount - 1)
        : w;
  }
}

/// Row 185: a content row with trailing actions — the actions keep their natural width (next to
/// the content, no stretched gap) and only wrap onto a second line when the row is too narrow
/// (a narrow column, a phone), so nothing overflows. [main] takes the remaining width.
class TrailingRow extends MultiChildRenderObjectWidget {
  TrailingRow({
    super.key,
    required Widget main,
    required Widget trailing,
    this.gap = 8,
    this.minMain = 140,
  }) : super(children: [main, trailing]);

  final double gap;

  /// The width [main] keeps before the actions start to wrap.
  final double minMain;

  @override
  RenderObject createRenderObject(BuildContext context) =>
      _RenderTrailingRow(gap, minMain, Directionality.of(context));

  @override
  void updateRenderObject(BuildContext context, RenderObject renderObject) =>
      (renderObject as _RenderTrailingRow)
        ..gap = gap
        ..minMain = minMain
        ..dir = Directionality.of(context);
}

class _TrailingParentData extends ContainerBoxParentData<RenderBox> {}

class _RenderTrailingRow extends RenderBox
    with
        ContainerRenderObjectMixin<RenderBox, _TrailingParentData>,
        RenderBoxContainerDefaultsMixin<RenderBox, _TrailingParentData> {
  _RenderTrailingRow(this._gap, this._minMain, this._dir);

  double _gap;
  set gap(double v) {
    if (v == _gap) return;
    _gap = v;
    markNeedsLayout();
  }

  double _minMain;
  set minMain(double v) {
    if (v == _minMain) return;
    _minMain = v;
    markNeedsLayout();
  }

  TextDirection _dir;
  set dir(TextDirection v) {
    if (v == _dir) return;
    _dir = v;
    markNeedsLayout();
  }

  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! _TrailingParentData) {
      child.parentData = _TrailingParentData();
    }
  }

  RenderBox get _main => firstChild!;
  RenderBox get _trail => lastChild!;

  /// The trailing width for a row [w] wide.
  double _trailWidth(double w) {
    final natural = _trail.getMaxIntrinsicWidth(double.infinity);
    if (!w.isFinite) return natural;
    final room = math.max(w - _gap - _minMain, w * 0.5);
    return math.min(natural, math.max(0, room));
  }

  @override
  double computeMinIntrinsicWidth(double height) =>
      _main.getMinIntrinsicWidth(height) +
      _gap +
      _trail.getMinIntrinsicWidth(height);

  @override
  double computeMaxIntrinsicWidth(double height) =>
      _main.getMaxIntrinsicWidth(height) +
      _gap +
      _trail.getMaxIntrinsicWidth(height);

  double _heightFor(double w) {
    final tw = _trailWidth(w);
    final th = _trail.getMinIntrinsicHeight(tw);
    final mw = w.isFinite ? math.max(0.0, w - tw - _gap) : double.infinity;
    return math.max(th, _main.getMinIntrinsicHeight(mw));
  }

  @override
  double computeMinIntrinsicHeight(double width) => _heightFor(width);

  @override
  double computeMaxIntrinsicHeight(double width) => _heightFor(width);

  @override
  Size computeDryLayout(BoxConstraints constraints) {
    final w = constraints.maxWidth;
    final tw = _trail.getDryLayout(BoxConstraints(maxWidth: _trailWidth(w)));
    final mw = w.isFinite
        ? math.max(0.0, w - tw.width - _gap)
        : double.infinity;
    final ms = _main.getDryLayout(BoxConstraints(maxWidth: mw));
    return constraints.constrain(
      Size(
        w.isFinite ? w : ms.width + _gap + tw.width,
        math.max(ms.height, tw.height),
      ),
    );
  }

  @override
  void performLayout() {
    final w = constraints.maxWidth;
    _trail.layout(
      BoxConstraints(maxWidth: _trailWidth(w)),
      parentUsesSize: true,
    );
    final tw = _trail.size.width;
    final mw = w.isFinite ? math.max(0.0, w - tw - _gap) : double.infinity;
    _main.layout(
      w.isFinite ? BoxConstraints.tightFor(width: mw) : const BoxConstraints(),
      parentUsesSize: true,
    );
    final width = w.isFinite ? w : _main.size.width + _gap + tw;
    final h = math.max(_main.size.height, _trail.size.height);
    size = constraints.constrain(Size(width, h));
    final rtl = _dir == TextDirection.rtl;
    (_main.parentData! as _TrailingParentData).offset = Offset(
      rtl ? size.width - _main.size.width : 0,
      (size.height - _main.size.height) / 2,
    );
    (_trail.parentData! as _TrailingParentData).offset = Offset(
      rtl ? 0 : size.width - tw,
      (size.height - _trail.size.height) / 2,
    );
  }

  @override
  void paint(PaintingContext context, Offset offset) =>
      defaultPaint(context, offset);

  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) =>
      defaultHitTestChildren(result, position: position);
}
