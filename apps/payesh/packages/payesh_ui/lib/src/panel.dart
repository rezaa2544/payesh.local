import 'package:flutter/material.dart';

import 'theme.dart';

/// Row 182: from this window width a detail / edit page opened with [openPanel] is a small,
/// centred panel instead of a full-window page (the owner's screenshot: «کاربری — …» filled the
/// whole Windows window). Phones keep the usual full-screen page — there the screen *is* small.
const double kPanelBreakpoint = 600;

/// Width of a [openPanel] panel: a form or a detail view.
const double kPanelWidth = 640;

/// Width of a [openPanel] panel that holds a table (Excel import preview and the like).
const double kPanelWideWidth = 960;

/// Tallest a panel gets, whatever the window.
const double kPanelMaxHeight = 760;

/// Opens [builder]'s page (a normal [Scaffold] with an [AppBar]) as a small, tidy panel on wide
/// windows — Windows, tablets, the owner app — and as the usual full-screen page on phones.
///
/// The page does not need to know: inside the panel [MediaQuery] reports the panel's own size,
/// so layouts that switch on width see a form-sized box, and the [AppBar] shows ✕ (the route is
/// a full-screen-dialog page route) that closes it like the back arrow did. A stray click
/// outside never throws away what was typed; ✕, «انصراف», Esc or the system back close it.
Future<T?> openPanel<T>(
  BuildContext context,
  WidgetBuilder builder, {
  double width = kPanelWidth,
}) {
  final nav = Navigator.of(context);
  if (MediaQuery.sizeOf(context).width < kPanelBreakpoint) {
    return nav.push<T>(MaterialPageRoute<T>(builder: builder));
  }
  return nav.push<T>(PanelRoute<T>(builder: builder, width: width));
}

/// The route behind [openPanel] on wide windows: a translucent page route that draws its page
/// in a rounded, hairline-bordered card at the centre of the window.
class PanelRoute<T> extends PageRoute<T> {
  PanelRoute({required this.builder, this.width = kPanelWidth, super.settings})
    : super(fullscreenDialog: true);

  final WidgetBuilder builder;
  final double width;

  @override
  bool get opaque => false;

  @override
  bool get barrierDismissible => false;

  @override
  Color? get barrierColor => Colors.black54;

  @override
  String? get barrierLabel => 'بستن';

  @override
  bool get maintainState => true;

  @override
  Duration get transitionDuration => const Duration(milliseconds: 180);

  @override
  Widget buildPage(
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
  ) {
    final mq = MediaQuery.of(context);
    final size = mq.size;
    final w = (size.width - 48).clamp(320.0, width);
    final h = (size.height - 32).clamp(320.0, kPanelMaxHeight);
    final tk = context.tokens;
    return SafeArea(
      child: Center(
        child: SizedBox(
          key: const Key('panel'),
          width: w,
          height: h > size.height ? size.height : h,
          child: Material(
            clipBehavior: Clip.antiAlias,
            color: Theme.of(context).colorScheme.surface,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
              side: BorderSide(color: tk.line),
            ),
            child: LayoutBuilder(
              builder: (context, box) => MediaQuery(
                data: mq.copyWith(
                  size: Size(box.maxWidth, box.maxHeight),
                  padding: EdgeInsets.zero,
                  viewPadding: EdgeInsets.zero,
                ),
                // the page behind stays visible: its own messenger keeps a snack bar of the
                // panel inside the panel (not twice, under it too)
                child: ScaffoldMessenger(child: Builder(builder: builder)),
              ),
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget buildTransitions(
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) {
    final curved = CurvedAnimation(parent: animation, curve: Curves.easeOut);
    return FadeTransition(
      opacity: curved,
      child: ScaleTransition(
        scale: Tween<double>(begin: 0.97, end: 1).animate(curved),
        child: child,
      ),
    );
  }
}

/// Whether [context] sits in a page opened as a panel by [openPanel].
bool inPanel(BuildContext context) => ModalRoute.of(context) is PanelRoute;

/// The icon of a page's own back button: ✕ inside a panel, the back arrow on a full page.
Widget backOrCloseIcon(BuildContext context) =>
    inPanel(context) ? const Icon(Icons.close) : const BackButtonIcon();

/// Tooltip matching [backOrCloseIcon].
String backOrCloseTooltip(BuildContext context) =>
    inPanel(context) ? 'بستن' : 'بازگشت';
